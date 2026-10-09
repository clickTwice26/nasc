"""Build the Analog Atlas Earth feature grid from the raw inputs in pipeline/.cache.

Output (all committed, consumed by the static web app and the tests):
  data/earth.bin   little-endian: Uint32 cell index[N] followed by Uint16 feature planes
  data/earth.json  grid + feature metadata (scale/offset, units, sources, percentiles),
                   region / country name tables
Grid: 0.5 deg equal-angle, 720 x 360 cells, row 0 = 89.75N, col 0 = 179.75W.
Only cells whose GLOBE land fraction >= 0.5 are stored.

Usage:  python pipeline/build.py
"""
import io
import json
import math
import os
import zipfile

import numpy as np
import xarray as xr
from PIL import Image, ImageDraw
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".cache")
OUT = os.path.join(HERE, "..", "data")
Image.MAX_IMAGE_PIXELS = None

RES = 0.5
NX, NY = int(360 / RES), int(180 / RES)
LAT = 90 - RES / 2 - RES * np.arange(NY)          # row centers, north -> south
LON = -180 + RES / 2 + RES * np.arange(NX)        # col centers, west -> east
LON2, LAT2 = np.meshgrid(LON, LAT)
R_EARTH = 6371.0


# ----------------------------------------------------------------------------- helpers
def wheel(prefix):
    d = os.path.join(CACHE, "wheels")
    return zipfile.ZipFile(os.path.join(d, next(f for f in os.listdir(d) if f.startswith(prefix))))


def regrid(da, lat_name="lat", lon_name="lon"):
    """Bilinear-ish resample of a (lat, lon) DataArray onto the 0.5 deg cell centres.
    NaNs are preserved (nearest neighbour fallback where interpolation hits NaN)."""
    da = da.sortby(lat_name).sortby(lon_name)
    lons = da[lon_name].values
    if lons[-1] - lons[0] >= 360 - 1e-6:          # periodic duplicate column (-180 == 180)
        da = da.isel({lon_name: slice(0, -1)})
    # wrap longitude so interpolation at the dateline works
    first = da.isel({lon_name: 0}).assign_coords({lon_name: da[lon_name][0] + 360})
    last = da.isel({lon_name: -1}).assign_coords({lon_name: da[lon_name][-1] - 360})
    da = xr.concat([last, da, first], dim=lon_name)
    tgt = {lat_name: xr.DataArray(LAT, dims="y"), lon_name: xr.DataArray(LON, dims="x")}
    lin = da.interp(tgt, method="linear").values
    lat_c = np.clip(LAT, float(da[lat_name].min()), float(da[lat_name].max()))
    near = da.interp({lat_name: xr.DataArray(lat_c, dims="y"), lon_name: tgt[lon_name]},
                     method="nearest").values
    out = np.where(np.isnan(lin), near, lin)
    return out.astype(np.float64)


def block_reduce(a, f, fn=np.nanmean):
    """Reduce a (NY*f, NX*f) array to (NY, NX) by fn over f x f blocks."""
    return fn(a.reshape(NY, f, NX, f), axis=(1, 3))


def unit_xyz(lat, lon):
    la, lo = np.radians(lat), np.radians(lon)
    return np.stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)], axis=-1)


def nearest_km(points_lat, points_lon, q_lat, q_lon, radius_km=None):
    """Great-circle distance (km) from each query point to the nearest point; optional
    per-point radius is subtracted (distance to the rim of a crater, clamped at 0)."""
    tree = cKDTree(unit_xyz(np.asarray(points_lat), np.asarray(points_lon)))
    chord, idx = tree.query(unit_xyz(q_lat, q_lon), k=8 if radius_km is not None else 1)
    ang = 2 * np.arcsin(np.clip(chord / 2, 0, 1))
    d = ang * R_EARTH
    if radius_km is not None:
        d = np.maximum(d - np.asarray(radius_km)[idx], 0).min(axis=1)
    return d


def polys(geom):
    if geom is None:
        return []
    if geom["type"] == "Polygon":
        return [geom["coordinates"]]
    if geom["type"] == "MultiPolygon":
        return geom["coordinates"]
    return []


def rasterize(features, scale=10, value_fn=None, order=None):
    """Rasterise GeoJSON polygons at (RES/scale) deg. Returns int32 label image
    (0 = none, k = feature index + 1). Later features paint over earlier ones."""
    W, H = NX * scale, NY * scale
    img = Image.new("I", (W, H), 0)
    dr = ImageDraw.Draw(img)
    idxs = order if order is not None else range(len(features))
    for k in idxs:
        f = features[k]
        val = (value_fn(k) if value_fn else k + 1)
        for poly in polys(f["geometry"]):
            for ri, ring in enumerate(poly):
                pts = [((x + 180) / 360 * W, (90 - y) / 180 * H) for x, y in ring]
                if len(pts) >= 3:
                    dr.polygon(pts, fill=(val if ri == 0 else 0))
    return np.array(img, dtype=np.int32)


def poly_area(f):
    a = 0.0
    for poly in polys(f["geometry"]):
        ring = np.asarray(poly[0])
        x, y = ring[:, 0] * np.cos(np.radians(ring[:, 1])), ring[:, 1]
        a += abs(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1))) / 2
    return a


def load_geojson(name):
    with open(os.path.join(CACHE, name), encoding="utf-8") as fh:
        return json.load(fh)["features"]


# ----------------------------------------------------------------------------- layers
def land_fraction():
    z = wheel("global_land_mask")
    npz = np.load(io.BytesIO(z.read("global_land_mask/globe_combined_mask_compressed.npz")))
    water = npz["mask"]  # (21600, 43200) bool, True = water; row 0 = 90N, 1/120 deg
    f = water.shape[0] // NY
    return 1.0 - block_reduce(water.astype(np.float32), f, np.mean)


def koppen():
    z = wheel("kgcpy")
    img = np.array(Image.open(io.BytesIO(z.read("kgcpy/kmz_int_reshape.png"))))  # 6480 x 12960
    f = img.shape[0] // NY
    blocks = img.reshape(NY, f, NX, f).transpose(0, 2, 1, 3).reshape(NY, NX, f * f)
    counts = np.stack([(blocks == k).sum(axis=2) for k in range(1, 32)], axis=-1)  # ignore 32=ocean
    mode = counts.argmax(axis=-1) + 1
    mode[counts.max(axis=-1) == 0] = 32
    zones = [l.split(",")[1] for l in z.read("kgcpy/kg_zoneNum.csv").decode().strip().splitlines()[1:]]
    return mode.astype(np.int32), zones


def topography():
    t = xr.open_dataset(os.path.join(CACHE, "earth-topography-10arcmin.nc"))["topography"]
    elev = regrid(t, "latitude", "longitude")
    # local relief: max - min of the 10' samples inside a ~1.5 deg window (km-scale ruggedness)
    v = t.values  # (1081, 2161), lat ascending
    from scipy.ndimage import maximum_filter, minimum_filter, generic_filter
    rel = maximum_filter(v, size=9, mode="wrap") - minimum_filter(v, size=9, mode="wrap")
    # slope proxy: rms gradient between neighbouring 10' samples (m per km)
    dy = 111.2 * (1 / 6)
    lat = np.radians(t.latitude.values)[:, None]
    dx = np.maximum(dy * np.cos(lat), 1.0)
    gy = np.gradient(v, axis=0) / dy
    gx = np.gradient(v, axis=1) / dx
    slope = np.degrees(np.arctan(np.hypot(gx, gy) / 1000.0))
    rel_da = xr.DataArray(rel, coords=t.coords, dims=t.dims)
    slope_da = xr.DataArray(slope, coords=t.coords, dims=t.dims)
    return elev, regrid(rel_da, "latitude", "longitude"), regrid(slope_da, "latitude", "longitude")


def lighting():
    """Analytic solar geometry per latitude (no atmosphere): fraction of sunlit time with
    the Sun < 10 deg above the horizon, and the fraction of the year in polar night.
    The lunar south pole never sees the Sun higher than ~1.5-7 deg."""
    decl = np.radians(23.44) * np.sin(2 * np.pi * (np.arange(365) - 80) / 365.0)
    H = np.radians(np.linspace(-180, 180, 289))
    low, night = [], []
    for la in np.radians(LAT):
        s = (np.sin(la) * np.sin(decl)[:, None] + np.cos(la) * np.cos(decl)[:, None] * np.cos(H)[None, :])
        el = np.degrees(np.arcsin(np.clip(s, -1, 1)))
        lit = el > 0
        low.append(((el > 0) & (el < 10)).sum() / max(lit.sum(), 1))
        night.append((el.max(axis=1) <= 0).mean())
    low = np.repeat(np.asarray(low)[:, None], NX, axis=1)
    night = np.repeat(np.asarray(night)[:, None], NX, axis=1)
    return low, night


def power():
    m = xr.open_dataset(os.path.join(CACHE, "power_merra2.nc"))
    s = xr.open_dataset(os.path.join(CACHE, "power_syn1deg.nc"))
    i = xr.open_dataset(os.path.join(CACHE, "power_imerg.nc"))
    ann = lambda ds, v: regrid(ds[v].sel(time=13))
    mon = lambda ds, v: np.stack([regrid(ds[v].sel(time=k)) for k in range(1, 13)])
    out = {
        "tmean": ann(m, "T2M"),
        "tcold": mon(m, "T2M_MIN_AVG").min(axis=0),
        "thot": mon(m, "T2M_MAX_AVG").max(axis=0),
        "dtr": ann(m, "TS_RANGE"),
        "tsmin": ann(m, "TS_MIN"),
        "tsmax": ann(m, "TS_MAX"),
        "qv": ann(m, "QV2M"),
        "rh": ann(m, "RH2M"),
        "ps": ann(m, "PS") / 10.0,                    # hPa -> kPa
        "frost": ann(m, "FROST_DAYS"),
        "tsoil": ann(m, "TSOIL6"),
        "snow": ann(m, "FRSNO"),
        "soilw": ann(m, "GWETTOP"),
        "et": ann(m, "EVPTRNS"),
        "wind": ann(m, "WS10M"),
        "uv": ann(s, "ALLSKY_SFC_UV_INDEX"),
        "albedo": ann(s, "ALLSKY_SRF_ALB"),
        "cloud": ann(s, "CLOUD_AMT"),
        "sw": ann(s, "ALLSKY_SFC_SW_DWN"),
    }
    merra_p = ann(m, "PRECTOTCORR")
    imerg = i["IMERG_PRECTOT"].values  # (1800, 3600) lat ascending, 0.1 deg
    imerg = np.flipud(imerg)           # -> north first
    imerg_05 = block_reduce(imerg, 5)
    out["precip"] = np.where(np.isfinite(imerg_05), imerg_05, merra_p) * 365.25  # mm/yr
    return out


# ----------------------------------------------------------------------------- main
FEATURES = [
    # id, label, unit, source, decimals
    ("tmean", "Mean air temperature", "°C", "NASA POWER · MERRA-2 T2M", 1),
    ("tcold", "Coldest-month mean minimum", "°C", "NASA POWER · MERRA-2 T2M_MIN_AVG", 1),
    ("thot", "Warmest-month mean maximum", "°C", "NASA POWER · MERRA-2 T2M_MAX_AVG", 1),
    ("dtr", "Surface diurnal temperature range", "°C", "NASA POWER · MERRA-2 TS_RANGE", 1),
    ("tsmin", "Extreme surface (skin) minimum", "°C", "NASA POWER · MERRA-2 TS_MIN", 1),
    ("tsmax", "Extreme surface (skin) maximum", "°C", "NASA POWER · MERRA-2 TS_MAX", 1),
    ("precip", "Annual precipitation", "mm/yr", "NASA GPM IMERG (POWER climatology)", 0),
    ("qv", "Specific humidity", "g/kg", "NASA POWER · MERRA-2 QV2M", 2),
    ("rh", "Relative humidity", "%", "NASA POWER · MERRA-2 RH2M", 0),
    ("ps", "Surface pressure", "kPa", "NASA POWER · MERRA-2 PS", 1),
    ("uv", "UV index (all-sky, daily mean)", "index", "NASA POWER · CERES SYN1deg", 2),
    ("albedo", "Surface albedo", "", "NASA POWER · CERES SYN1deg", 2),
    ("cloud", "Cloud amount", "%", "NASA POWER · CERES SYN1deg", 0),
    ("sw", "Solar irradiance (all-sky)", "W/m²", "NASA POWER · CERES SYN1deg", 0),
    ("frost", "Frost days", "days/yr", "NASA POWER · MERRA-2 FROST_DAYS", 0),
    ("tsoil", "Deep soil temperature (permafrost proxy)", "°C", "NASA POWER · MERRA-2 TSOIL6", 1),
    ("snow", "Snow / ice cover fraction", "", "NASA POWER · MERRA-2 FRSNO + Natural Earth glaciers", 2),
    ("landfrac", "Land fraction of cell", "", "GLOBE 1 km land mask", 2),
    ("soilw", "Surface soil wetness", "", "NASA POWER · MERRA-2 GWETTOP", 2),
    ("et", "Evapotranspiration (biosphere activity)", "W/m²", "NASA POWER · MERRA-2 EVPTRNS", 1),
    ("wind", "Wind speed at 10 m", "m/s", "NASA POWER · MERRA-2 WS10M", 1),
    ("elev", "Elevation", "m", "NOAA ETOPO1 (10′, Fatiando a Terra)", 0),
    ("relief", "Local relief (~150 km window)", "m", "NOAA ETOPO1 (10′)", 0),
    ("slope", "Mean slope (10′ grid)", "°", "NOAA ETOPO1 (10′)", 2),
    ("lowsun", "Sunlit time with Sun < 10° elevation", "", "Solar geometry (computed)", 3),
    ("polarnight", "Fraction of year in polar night", "", "Solar geometry (computed)", 3),
    ("ice", "Ice-covered fraction of cell", "", "Natural Earth glaciers × CERES albedo", 2),
    ("d_ice", "Distance to glacier / ice sheet", "km", "Natural Earth glaciated areas", 0),
    ("d_volcano", "Distance to nearest volcano", "km", "OpenStreetMap natural=volcano", 0),
    ("d_crater", "Distance to nearest impact structure rim", "km", "Earth Impact Database (PASSC)", 0),
    ("d_playa", "Distance to playa / salt flat", "km", "Natural Earth playas", 0),
    ("d_access", "Distance to airport, town or research station", "km", "Natural Earth + COMNAP", 0),
]


def main():
    os.makedirs(OUT, exist_ok=True)
    print("land mask…")
    landf = land_fraction()
    land = landf >= 0.25   # keeps volcanic islands (Lanzarote, Hawaii, Iceland coasts)
    print("koppen…")
    kg, kg_zones = koppen()
    print("power…")
    F = power()
    print("topography…")
    F["elev"], F["relief"], F["slope"] = topography()
    print("lighting…")
    F["lowsun"], F["polarnight"] = lighting()
    F["landfrac"] = landf

    print("vector layers…")
    glac = load_geojson("ne_10m_glaciated_areas.geojson")
    gl = rasterize(glac, scale=10) > 0
    ne_ice = block_reduce(gl.astype(np.float32), 10, np.mean)
    # Natural Earth paints all of Antarctica as glaciated. CERES all-sky albedo separates
    # bright ice from darker ice-free oases (McMurdo Dry Valleys ~0.55 vs plateau ~0.8).
    alb = np.where(np.isnan(F["albedo"]), 0.8, F["albedo"])
    F["ice"] = ne_ice * np.clip((alb - 0.35) / 0.40, 0, 1)

    # MERRA-2 land-surface variables are undefined over land ice: fill physically.
    ice_sheet = np.isnan(F["tsoil"])
    F["tsoil"] = np.where(ice_sheet, np.minimum(F["tmean"], 0), F["tsoil"])
    F["snow"] = np.where(np.isnan(F["snow"]), 1.0, F["snow"])
    F["snow"] = np.maximum(F["snow"], F["ice"])
    F["et"] = np.where(np.isnan(F["et"]), 0.0, F["et"])
    F["albedo"] = np.where(np.isnan(F["albedo"]), 0.8, F["albedo"])

    craters = load_geojson("craters.geojson")
    c_lat = [f["geometry"]["coordinates"][1] for f in craters]
    c_lon = [f["geometry"]["coordinates"][0] for f in craters]
    c_rad = [float(f["properties"].get("diameter") or 0) / 2 for f in craters]
    volc = load_geojson("volcanoes.geojson")
    v_lat = [f["geometry"]["coordinates"][1] for f in volc]
    v_lon = [f["geometry"]["coordinates"][0] for f in volc]

    playas = load_geojson("ne_10m_playas.geojson")
    pl = rasterize(playas, scale=10) > 0
    py, px = np.nonzero(pl)
    p_lat = 90 - (py + 0.5) * RES / 10
    p_lon = -180 + (px + 0.5) * RES / 10

    air = load_geojson("ne_10m_airports.geojson")
    towns = [f for f in load_geojson("ne_10m_populated_places_simple.geojson")
             if (f["properties"].get("pop_max") or 0) >= 5000 or "station" in (f["properties"].get("featurecla") or "").lower()]
    stations = load_geojson("antarctic_stations.geojson")
    a_pts = [f["geometry"]["coordinates"] for f in air + towns + stations]

    ql, qo = LAT2[land], LON2[land]
    dist = {}
    gy, gx = np.nonzero(gl[::2, ::2])                       # 0.1 deg glacier pixels
    dist["d_ice"] = nearest_km(90 - (gy + 0.5) * 0.1, -180 + (gx + 0.5) * 0.1, ql, qo)
    dist["d_volcano"] = nearest_km(v_lat, v_lon, ql, qo)
    dist["d_crater"] = nearest_km(c_lat, c_lon, ql, qo, radius_km=c_rad)
    dist["d_playa"] = nearest_km(p_lat, p_lon, ql, qo)
    dist["d_access"] = nearest_km([p[1] for p in a_pts], [p[0] for p in a_pts], ql, qo)
    for k, v in dist.items():
        full = np.full((NY, NX), np.nan)
        full[land] = v
        F[k] = full

    print("names…")
    regions = load_geojson("ne_10m_geography_regions_polys.geojson")
    keep = [k for k, f in enumerate(regions)
            if f["properties"]["FEATURECLA"] not in ("Continent", "Ocean", "Sea")]
    order = sorted(keep, key=lambda k: -poly_area(regions[k]))   # big first, small paints over
    reg = rasterize(regions, scale=2, order=order)
    reg = reg[::2, ::2][:NY, :NX]
    # unnamed cells (much of Antarctica, open plains): borrow the nearest named region within
    # 600 km and flag it with bit 15 so the UI can say "near …"
    named = (reg > 0) & land
    tree_r = cKDTree(unit_xyz(LAT2[named], LON2[named]))
    need = land & (reg == 0)
    dch, nn = tree_r.query(unit_xyz(LAT2[need], LON2[need]))
    km = 2 * np.arcsin(np.clip(dch / 2, 0, 1)) * R_EARTH
    fill = np.where(km < 600, reg[named][nn] | 0x8000, 0)
    reg[need] = fill
    countries = load_geojson("ne_50m_admin_0_countries.geojson")
    cty = rasterize(countries, scale=2)[::2, ::2][:NY, :NX]
    # fill coastal cells without a country polygon with nearest country cell
    ok = cty > 0
    tree = cKDTree(unit_xyz(LAT2[ok], LON2[ok]))
    _, nn = tree.query(unit_xyz(LAT2[land & ~ok], LON2[land & ~ok]))
    cty[land & ~ok] = cty[ok][nn]
    region_names = [""] + [f"{regions[k]['properties'].get('NAME_EN') or regions[k]['properties']['NAME']}|{regions[k]['properties']['FEATURECLA']}" for k in range(len(regions))]
    country_names = [""] + [c["properties"].get("NAME_EN") or c["properties"]["NAME"] for c in countries]

    # ------------------------------------------------------------------ pack
    idx = np.flatnonzero(land.ravel())
    n = idx.size
    meta = {"grid": {"res": RES, "nx": NX, "ny": NY, "lat0": float(LAT[0]), "lon0": float(LON[0]),
                     "order": "row-major, row 0 = north"},
            "count": int(n), "features": [], "koppen": kg_zones,
            "regions": region_names, "countries": country_names,
            "generated": "pipeline/build.py"}
    planes = []
    for fid, label, unit, src, dec in FEATURES:
        v = F[fid].ravel()[idx].astype(np.float64)
        if np.isnan(v).any():
            fill = np.nanmedian(v)
            print(f"  {fid}: filling {int(np.isnan(v).sum())} NaN with median {fill:.3g}")
            v = np.where(np.isnan(v), fill, v)
        lo, hi = float(v.min()), float(v.max())
        scale = (hi - lo) / 65535 if hi > lo else 1.0
        q = np.round((v - lo) / scale).astype(np.uint16)
        planes.append(q)
        pct = np.percentile(v, [1, 5, 25, 50, 75, 95, 99]).round(4).tolist()
        meta["features"].append({"id": fid, "label": label, "unit": unit, "source": src,
                                 "decimals": dec, "offset": lo, "scale": scale,
                                 "min": lo, "max": hi, "pct": pct})
    cats = np.stack([kg.ravel()[idx], reg.ravel()[idx], cty.ravel()[idx]]).astype(np.uint16)
    meta["categorical"] = ["koppen", "region", "country"]
    with open(os.path.join(OUT, "earth.bin"), "wb") as fh:
        fh.write(idx.astype("<u4").tobytes())
        for q in planes:
            fh.write(q.astype("<u2").tobytes())
        fh.write(cats.astype("<u2").tobytes())
    with open(os.path.join(OUT, "earth.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {n} land cells x {len(planes)} features "
          f"({os.path.getsize(os.path.join(OUT, 'earth.bin')) / 1e6:.1f} MB)")

    # ------------------------------------------------------------------ textures
    z = wheel("basemap_data")
    tex = os.path.join(HERE, "..", "assets", "textures")
    os.makedirs(tex, exist_ok=True)
    bm = Image.open(io.BytesIO(z.read("mpl_toolkits/basemap_data/bmng.jpg"))).convert("RGB")
    bm.resize((4096, 2048), Image.LANCZOS).save(os.path.join(tex, "earth_bmng_4096.jpg"), quality=86)
    bm.resize((2048, 1024), Image.LANCZOS).save(os.path.join(tex, "earth_bmng_2048.jpg"), quality=86)
    print("textures written")


if __name__ == "__main__":
    main()

"""Download every raw input used by Analog Atlas into pipeline/.cache.

All sources are open data. Nothing here needs an API key.

  * NASA POWER climatologies (MERRA-2, CERES SYN1deg, GPM IMERG) — AWS Open Data
    bucket s3://nasa-power (anonymous, Zarr).
  * ETOPO1-derived 10 arc-minute global relief (NOAA NCEI via Fatiando a Terra).
  * Koppen-Geiger climate map, 100 arc-second (Rubel et al. 2017, via kgcpy).
  * GLOBE 1 km land mask (via global-land-mask).
  * NASA Blue Marble Next Generation (via basemap-data).
  * Natural Earth vectors (public domain): geographic region names, playas,
    glaciated areas, airports, populated places, countries.
  * Earth Impact Database crater list (PASSC, via a GeoJSON snapshot),
    OpenStreetMap natural=volcano points (ODbL), COMNAP Antarctic stations.

Usage:  python pipeline/fetch.py
"""
import io
import json
import os
import subprocess
import sys
import tarfile
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".cache")
os.makedirs(CACHE, exist_ok=True)

NE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/"
NE_FILES = [
    "ne_10m_geography_regions_polys.geojson",
    "ne_10m_geography_regions_points.geojson",
    "ne_10m_playas.geojson",
    "ne_10m_glaciated_areas.geojson",
    "ne_10m_airports.geojson",
    "ne_10m_populated_places_simple.geojson",
    "ne_50m_admin_0_countries.geojson",
]
TOPO = ("https://github.com/fatiando-data/earth-topography-10arcmin/releases/"
        "download/v1/earth-topography-10arcmin.nc")
NPM = {
    "craters.geojson": "@worldwideview/wwv-plugin-earth-impact-craters",
    "volcanoes.geojson": "@worldwideview/wwv-plugin-volcanoes",
    "antarctic_stations.geojson": "@worldwideview/wwv-plugin-antarctic-stations",
}
PYPI = {"kgcpy": "kgcpy==1.1.8", "global_land_mask": "global-land-mask==1.0.0",
        "basemap_data": "basemap-data==2.0.0"}

POWER = {
    "merra2": ("s3://nasa-power/merra2/spatial/power_merra2_climatology_spatial_utc.zarr",
               ["T2M", "T2M_MAX_AVG", "T2M_MIN_AVG", "TS_RANGE", "TS_MAX", "TS_MIN",
                "PRECTOTCORR", "QV2M", "RH2M", "PS", "FROST_DAYS", "TSOIL6", "FRSNO",
                "GWETTOP", "EVPTRNS", "WS10M"]),
    "syn1deg": ("s3://nasa-power/syn1deg/spatial/power_syn1deg_climatology_spatial_utc.zarr",
                ["ALLSKY_SFC_UV_INDEX", "ALLSKY_SFC_UVB", "ALLSKY_SRF_ALB", "CLOUD_AMT",
                 "ALLSKY_SFC_SW_DWN", "CLRSKY_DAYS"]),
    "imerg": ("s3://nasa-power/imerg/spatial/power_imerg_climatology_spatial_utc.zarr",
              ["IMERG_PRECTOT"]),
}


def get(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return
    print("  GET", url)
    with urllib.request.urlopen(url, timeout=300) as r, open(dest + ".part", "wb") as f:
        f.write(r.read())
    os.replace(dest + ".part", dest)


def fetch_power():
    import xarray as xr
    for name, (url, variables) in POWER.items():
        dest = os.path.join(CACHE, f"power_{name}.nc")
        if os.path.exists(dest):
            continue
        print("  POWER", name, variables)
        ds = xr.open_zarr(url, storage_options={"anon": True})[variables]
        if name == "imerg":  # 0.1 deg: keep the annual slice only (time index 13)
            ds = ds.sel(time=13)
        ds.load().to_netcdf(dest)


def fetch_npm():
    for out, pkg in NPM.items():
        dest = os.path.join(CACHE, out)
        if os.path.exists(dest):
            continue
        print("  npm", pkg)
        tgz = subprocess.check_output(["npm", "pack", pkg, "--silent"], cwd=CACHE).decode().split()[-1]
        with tarfile.open(os.path.join(CACHE, tgz)) as t:
            data = t.extractfile("package/data/data.json").read()
        with open(dest, "wb") as f:
            f.write(data)
        os.remove(os.path.join(CACHE, tgz))


def fetch_pypi():
    wheels = os.path.join(CACHE, "wheels")
    os.makedirs(wheels, exist_ok=True)
    for key, spec in PYPI.items():
        if any(fn.startswith(key) for fn in os.listdir(wheels)):
            continue
        print("  pypi", spec)
        subprocess.check_call([sys.executable, "-m", "pip", "download", "--no-deps", "-q",
                               "-d", wheels, spec])


def main():
    print("Natural Earth…")
    for fn in NE_FILES:
        get(NE + fn, os.path.join(CACHE, fn))
    print("ETOPO 10' relief…")
    get(TOPO, os.path.join(CACHE, "earth-topography-10arcmin.nc"))
    print("npm data snapshots…")
    fetch_npm()
    print("PyPI data wheels…")
    fetch_pypi()
    print("NASA POWER (AWS Open Data)…")
    fetch_power()
    print("done ->", CACHE)


if __name__ == "__main__":
    main()

#!/usr/bin/env bash
# Downloads the raw open data the compile step needs into data/raw/ (~215 MB).
set -euo pipefail
cd "$(dirname "$0")/../data/raw"

get() { [ -f "$1" ] || curl -fL# -o "$1" "$2"; }

get terr50_gagg_gb.zip \
  "https://api.os.uk/downloads/v1/products/Terrain50/downloads?area=GB&format=ASCII+Grid+and+GML+%28Grid%29&redirect"
get oprvrs_gpkg_gb.zip \
  "https://api.os.uk/downloads/v1/products/OpenRivers/downloads?area=GB&format=GeoPackage&redirect"
get ne_subunits.zip \
  "https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_0_map_subunits.zip"

[ -d terr50 ] || unzip -q terr50_gagg_gb.zip -d terr50
[ -d Data ] || unzip -q oprvrs_gpkg_gb.zip
[ -d ne_subunits ] || unzip -q ne_subunits.zip -d ne_subunits

echo "raw data ready in $(pwd)"

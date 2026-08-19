import { NextResponse } from "next/server";
export const dynamic="force-dynamic"; export const runtime="nodejs";
const base="https://geo.rijkswaterstaat.nl/arcgis/rest/services/GDR/omgevingswet/FeatureServer/45/query";
export async function GET(){const p=new URLSearchParams({where:"1=1",outFields:"*",returnGeometry:"true",geometry:"4.20,51.15,6.55,52.30",geometryType:"esriGeometryEnvelope",inSR:"4326",spatialRel:"esriSpatialRelIntersects",outSR:"4326",resultRecordCount:"20",f:"geojson"});const r=await fetch(`${base}?${p}`,{cache:"no-store"});const text=await r.text();let json:unknown=null;try{json=JSON.parse(text);}catch{}return NextResponse.json({status:r.status,contentType:r.headers.get("content-type"),sample:json??text.slice(0,16000)});}

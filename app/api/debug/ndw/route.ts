import { NextResponse } from "next/server";
export const dynamic="force-dynamic"; export const runtime="nodejs";
const url="https://geo.rijkswaterstaat.nl/services/ogc/gdr/nwb_wegen/ows?service=WFS&version=2.0.0&request=GetFeature&typeName=hectopunten&outputFormat=json&count=12&srsName=EPSG%3A4326";
export async function GET(){const r=await fetch(url,{cache:"no-store"});const text=await r.text();let json:unknown=null;try{json=JSON.parse(text);}catch{}return NextResponse.json({status:r.status,contentType:r.headers.get("content-type"),sample:json??text.slice(0,12000)});}

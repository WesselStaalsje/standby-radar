import type { Metadata } from "next";
import "leaflet/dist/leaflet.css";
import "./globals.css";
import "./map-marker-overrides.css";
import { TomTomIncidentIconSkin } from "@/components/tomtom-incident-icon-skin";

export const metadata: Metadata = {
  title: "Standby Radar",
  description: "Realtime verkeersbeeld en stand-by advies voor berging in Brabant en Gelderland.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="nl">
      <body>
        <TomTomIncidentIconSkin />
        {children}
      </body>
    </html>
  );
}

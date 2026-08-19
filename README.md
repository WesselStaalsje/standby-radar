# Standby Radar

Zelfstandige realtime verkeerskaart voor operationele stand-by advisering van bergingsvoertuigen in Noord-Brabant en Gelderland.

## Versie 0.1

- OpenStreetMap + Leaflet interactieve kaart
- NDW Actueel Beeld voor incidenten, obstakels, afsluitingen en verkeerssituaties
- NDW Matrixsignaalinformatie voor actuele matrixmaatregelen
- Open-Meteo voor lokaal weer rond adviescorridors
- Automatische refresh iedere 60 seconden
- Experimentele stand-by score per corridor
- Uitleg waarom een corridor hoog of laag scoort
- Geen betaalde API-key nodig
- GitHub Actions controleert automatisch of de productie-build slaagt

## Lokaal draaien

```bash
npm install
npm run dev
```

Open daarna `http://localhost:3000`.

## Deployen op Vercel

Importeer deze GitHub-repository als nieuw Vercel-project. Framework: Next.js. Er zijn voor versie 0.1 geen environment variables nodig.

## Belangrijk

De huidige adviespunten zijn corridorzones en nog geen gevalideerde veilige parkeerlocaties. De score is beslisondersteuning en geen automatische inzetopdracht. Een volgende versie koppelt actuele snelheden/intensiteiten en een database met veilige stand-by locaties.

// Where on Earth to drive: ?place=oslo (a preset), ?place=59.9133,10.7389 (latitude,longitude),
// or ?place=<any address or name> (looked up with OpenStreetMap's Nominatim geocoder).
export const PLACES = {
  // Slottsplassen, in front of the Royal Palace, at the top of Karl Johans gate.
  oslo: { lat: 59.91635, lon: 10.73045, name: 'Oslo' },
};

export async function resolvePlace(query) {
  const key = query.trim().toLowerCase();
  if (PLACES[key]) return PLACES[key];
  const match = key.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (match) return { lat: Number(match[1]), lon: Number(match[2]), name: query };
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
  const results = await fetch(url, { mode: 'cors' }).then((r) => (r.ok ? r.json() : []));
  if (!results.length) throw new Error(`Place not found: ${query}`);
  return { lat: Number(results[0].lat), lon: Number(results[0].lon), name: results[0].display_name ?? query };
}

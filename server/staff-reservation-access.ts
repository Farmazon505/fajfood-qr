import type { CrmStaffSnapshot } from "./crm-reservations";

const normalizeZone = (value: string) => value
  .toLocaleLowerCase("ru-RU")
  .replace(/ё/g, "е")
  .replace(/[^a-zа-я0-9]+/gi, " ")
  .trim();

export const staffZoneMatchesHall = (zones: string[], hallKey: string, hallName: string) => {
  if (!zones.length) return false;
  const hallValues = [hallKey, hallName].map(normalizeZone);
  const hallFloors = new Set(hallValues.flatMap((value) => value.match(/\d+/g) || []));
  return zones.some((zone) => {
    const normalized = normalizeZone(zone);
    const zoneFloors = normalized.match(/\d+/g) || [];
    if (zoneFloors.some((floor) => hallFloors.has(floor))) return true;
    return hallValues.some((hall) => hall.includes(normalized) || normalized.includes(hall));
  });
};

export const filterSnapshotForZones = (snapshot: CrmStaffSnapshot, zones: string[]) => {
  const allowedHalls = snapshot.halls.filter((hall) => staffZoneMatchesHall(zones, hall.key, hall.name));
  const allowedKeys = new Set(allowedHalls.map((hall) => hall.key));
  return {
    ...snapshot,
    halls: allowedHalls,
    decor: snapshot.decor.filter((item) => allowedKeys.has(item.hallKey)),
    tables: snapshot.tables.filter((table) => allowedKeys.has(table.hall))
  };
};

// The five positional practices, shared by the kiosk, the Master Schedule tab,
// the Manual Attendance tab and the attendance-sheet builder, so a check-in is
// recognized as "positional" the same way everywhere.
//
// Players aren't tagged with a position: any player can attend any positional
// (several in one Saturday). A positional check-in is recorded with a sessionId
// that is either a Master Schedule positional entry's id (when one is scheduled
// that day) or "positional-<key>" (when none is).
export const POSITIONAL_PRACTICES = [
  { key: "setter", name: "Setter" },
  { key: "outside-hitter", name: "Outside Hitter" },
  { key: "middle-blocker", name: "Middle Blocker" },
  { key: "right-side-hitter", name: "Right Side Hitter" },
  { key: "libero-defense", name: "Libero/Defense" },
];

export const POSITIONAL_ID_PREFIX = "positional-";
export const SATURDAY = 6; // Date.getDay()

export const positionalSessionId = (key) => `${POSITIONAL_ID_PREFIX}${key}`;
export const isPositionalSessionId = (id) => typeof id === "string" && id.startsWith(POSITIONAL_ID_PREFIX);
export const positionalName = (key) => POSITIONAL_PRACTICES.find((p) => p.key === key)?.name || "";

// Master Schedule entries made before the rename used "Opposite" and
// "Libero"; they map onto the current practices.
const ALIASES = {
  setter: "setter",
  "outside hitter": "outside-hitter",
  "middle blocker": "middle-blocker",
  "right side hitter": "right-side-hitter",
  "right side": "right-side-hitter",
  opposite: "right-side-hitter",
  libero: "libero-defense",
  "libero/defense": "libero-defense",
  "libero defense": "libero-defense",
  "defensive specialist": "libero-defense",
};

// Is this check-in for a positional practice? Positional check-ins reach the
// database three ways, and all of them count:
//  - the kiosk's Saturday buttons / Manual Attendance (id "positional-<key>"),
//  - a scheduled positional entry on the Master Schedule (its id), or
//  - the kiosk's MANUAL picker, whose sessions are free-text names the director
//    made on the Practice Sessions tab ("OH Positional", "DEF Positional", ...) and
//    have their own ids — recognized by "Positional" in the session name.
export function isPositionalCheckIn({ sessionId, sessionLabel }, scheduledPositionalIds = new Set()) {
  return (
    scheduledPositionalIds.has(sessionId) ||
    isPositionalSessionId(sessionId) ||
    /positional/i.test(String(sessionLabel || ""))
  );
}

export function positionalKeyFor(name) {
  return ALIASES[String(name || "").trim().toLowerCase().replace(/\s+/g, " ")] || null;
}

// Rules from a factory: the same logic for several rooms, one rule each. Every rule gets its
// own ID (rooms#lights off in <room>), its own status and its own log tag.
import { forceOff, onChange, rule } from "@home-engine/sdk";

const rooms = [
  { name: "kitchen", window: "cover.kitchen_window", light: "light.kitchen_lights" },
  { name: "hall", window: "cover.hall_window", light: "light.ceiling_lights" },
];

for (const room of rooms) {
  // Opening the window turns the room's light off, so it does not attract insects.
  rule(`lights off in ${room.name}`, onChange(room.window, { to: "open" }), () =>
    forceOff(room.light),
  );
}

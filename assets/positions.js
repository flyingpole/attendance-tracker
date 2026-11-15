// The positional practices, as a list of names — used by the Master Schedule
// tab's positional dropdown and the roster import. (See positional.js for how
// positional check-ins work; players themselves aren't tagged with a position.)
import { POSITIONAL_PRACTICES } from "./positional.js";

export const POSITIONS = POSITIONAL_PRACTICES.map((p) => p.name);

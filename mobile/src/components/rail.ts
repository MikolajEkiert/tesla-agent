import { StyleSheet } from "react-native";
import { color } from "../theme";

/**
 * The system rail.
 *
 * A turn that touched the car is drawn as one continuous hairline down the left
 * of the transcript, carrying a dot per vehicle system involved and ending
 * where the reply starts. It is the app's one structural flourish, and it is
 * only ever there when it is true: a reply that touched nothing has no rail,
 * just the same left edge so nothing shifts.
 *
 * Shared here because three components have to agree on the geometry to the
 * pixel, or the segments they each draw will not join into one line.
 */
export const RAIL_GUTTER = 28;

export const railStyles = StyleSheet.create({
  gutter: {
    width: RAIL_GUTTER,
  },
  /** Full height: a segment between two dots. */
  line: {
    position: "absolute",
    left: RAIL_GUTTER / 2 - 1,
    top: 0,
    bottom: 0,
    width: 1.5,
    backgroundColor: color.hairline,
  },
  /** The end of the run, level with the first line of the reply. */
  lineStub: {
    position: "absolute",
    left: RAIL_GUTTER / 2 - 1,
    top: 0,
    height: 14,
    width: 1.5,
    borderBottomLeftRadius: 1,
    borderBottomRightRadius: 1,
    backgroundColor: color.hairline,
  },
});

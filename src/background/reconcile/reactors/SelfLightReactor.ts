import { Reactor } from "../Reactor";
import { SelfLightActor } from "../actors/SelfLightActor";
import { Reconciler } from "../Reconciler";
import { Item } from "@owlbear-rodeo/sdk";
import { hasLightConfig, readLightConfig } from "../../../util/lightKeys";

export class SelfLightReactor extends Reactor {
  constructor(reconciler: Reconciler) {
    super(reconciler, SelfLightActor);
  }

  filter(item: Item): boolean {
    if (!hasLightConfig(item)) {
      return false;
    }

    const config = readLightConfig(item);

    // Only show self light for primary lights that are angled
    return (
      config.outerAngle !== undefined &&
      config.outerAngle !== 360 &&
      (config.lightType === "PRIMARY" || config.lightType === undefined)
    );
  }
}

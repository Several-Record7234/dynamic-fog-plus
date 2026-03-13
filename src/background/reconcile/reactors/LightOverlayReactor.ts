import { Reactor } from "../Reactor";
import { Reconciler } from "../Reconciler";
import { Item } from "@owlbear-rodeo/sdk";
import { LightOverlayActor } from "../actors/LightOverlayActor";
import { hasLightConfig } from "../../../util/lightKeys";

export class LightOverlayReactor extends Reactor {
  constructor(reconciler: Reconciler) {
    super(reconciler, LightOverlayActor);
  }

  filter(item: Item): boolean {
    return hasLightConfig(item);
  }
}

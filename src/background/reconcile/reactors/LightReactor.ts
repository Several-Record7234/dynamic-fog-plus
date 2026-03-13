import { Reactor } from "../Reactor";
import { LightActor } from "../actors/LightActor";
import { Reconciler } from "../Reconciler";
import { Item } from "@owlbear-rodeo/sdk";
import { hasLightConfig } from "../../../util/lightKeys";

export class LightReactor extends Reactor {
  constructor(reconciler: Reconciler) {
    super(reconciler, LightActor);
  }

  filter(item: Item): boolean {
    return hasLightConfig(item);
  }
}

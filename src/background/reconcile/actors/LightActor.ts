import { buildLight, isLight, Item, Light } from "@owlbear-rodeo/sdk";
import { Actor } from "../Actor";
import { Reconciler } from "../Reconciler";
import { LightConfig } from "../../../types/LightConfig";
import { readLightConfig } from "../../../util/lightKeys";

export class LightActor extends Actor {
  // ID of the current light item
  private light: string;
  constructor(reconciler: Reconciler, parent: Item) {
    super(reconciler);
    const item = this.parentToLight(parent);
    this.light = item.id;
    this.reconciler.patcher.addItems(item);
  }

  delete(): void {
    this.reconciler.patcher.deleteItems(this.light);
  }

  update(parent: Item) {
    const config = readLightConfig(parent);
    this.reconciler.patcher.updateItems([
      this.light,
      (item) => {
        if (isLight(item)) {
          this.applyLightConfig(parent, item, config);
        }
      },
    ]);
  }

  private parentToLight(parent: Item) {
    const config = readLightConfig(parent);
    const light = buildLight()
      .attachedTo(parent.id)
      .position(parent.position)
      .rotation(parent.rotation)
      .visible(parent.visible)
      .disableAttachmentBehavior(["SCALE", "COPY"])
      .build();

    this.applyLightConfig(parent, light, config);

    return light;
  }

  private applyLightConfig(parent: Item, light: Light, config: LightConfig) {
    if (
      config.attenuationRadius !== undefined &&
      config.attenuationRadius !== light.attenuationRadius
    ) {
      light.attenuationRadius = config.attenuationRadius;
    }
    if (
      config.sourceRadius !== undefined &&
      config.sourceRadius !== light.sourceRadius
    ) {
      light.sourceRadius = config.sourceRadius;
    }
    if (config.falloff !== undefined && config.falloff !== light.falloff) {
      light.falloff = config.falloff;
    }
    if (
      config.innerAngle !== undefined &&
      config.innerAngle !== light.innerAngle
    ) {
      light.innerAngle = config.innerAngle;
    }
    if (
      config.outerAngle !== undefined &&
      config.outerAngle !== light.outerAngle
    ) {
      light.outerAngle = config.outerAngle;
    }
    if (
      config.lightType !== undefined &&
      config.lightType !== light.lightType
    ) {
      light.lightType = config.lightType;
    }
    if (config.rotation !== undefined) {
      light.rotation = parent.rotation + config.rotation;
    }

    return light;
  }
}

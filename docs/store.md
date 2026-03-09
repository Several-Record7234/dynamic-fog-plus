---
title: Dynamic Fog
description: Add walls, doors and lights for a simple dynamic fog experience
author: Owlbear Rodeo
image: https://raw.githubusercontent.com/owlbear-rodeo/dynamic-fog/main/docs/header.jpg
icon: https://dynamic-fog.owlbear.rodeo/logo.png
tags:
  - fog
manifest: https://dynamic-fog.owlbear.rodeo/manifest.json
learn-more: https://extensions.owlbear.rodeo/dynamic-fog
---

# Dynamic Fog

Add walls, doors and lights for a simple dynamic fog experience

## Add a Light

To add a light you can select any image in a Scene and click the Add Light button in the context menu.

![Add light context menu item](https://raw.githubusercontent.com/owlbear-rodeo/dynamic-fog/main/docs/light.jpg)

Once added you can adjust your lights settings as needed using the Light Settings panel.

![Light settings context menu item](https://raw.githubusercontent.com/owlbear-rodeo/dynamic-fog/main/docs/settings.jpg)

A description of the settings are listed below:

| Menu Item | Description                                                                  |
| --------- | ---------------------------------------------------------------------------- |
| Range     | The radius of the light in the current units of the Scene                    |
| Angle     | Whether the light should be a full circle or a cone                          |
| Edge      | Whether the edge of the light should be solid or blurred                     |
| Type      | Whether the light should be a primary or secondary light. More details below |

To remove a light you can click the Remove Light button at the bottom of the Light Settings

## Add a Wall

Walls are automatically created from the fog shapes of the native Owlbear Rodeo fog tools.
For a guide on using the native fog tool see [here](https://docs.owlbear.rodeo/docs/fog/).

## Add a Door

A door can be added to any wall by using the Door tool in the fog toolbar.

![Door tool](https://raw.githubusercontent.com/owlbear-rodeo/dynamic-fog/main/docs/doorTool.jpg)

With the door tool selected drag on the edge of any fog shape to create a door. This looks like the left side of the image below.
Once a door has been created it is represented by a path showing the extent of the door as well as a door icon showing the center of the door.
These controls will only show when the fog tool is selected.
When a door is closed the door path will be red and the door icon will show a closed door. This can be seen in the center image below.
When a door is opened the door path will be green and the door icon will show an open door. This can be seen in the right image below.

![Door creation](https://raw.githubusercontent.com/owlbear-rodeo/dynamic-fog/main/docs/doors.jpg)

With the door tool selected you can open/close a door by clicking it.
Also with the door tool selected you can delete a door by double clicking it.

## Secondary Lighting

Each light can be marked as either primary or secondary.
This is controlled by the Type option in the Light Settings.
The person icon represents a primary light while the campfire icon represents a secondary.
A primary light is a regular shadow casting light that when visible will always cut away from the fog.
A secondary light however only effects fog that can be seen by a primary light.
For example setting a light above the enemies campfire as secondary will mean that the camp will only be visible once a player with a primary light gains line of sight to that fire.

**Support**

If you need support for this extension you can email <support@owlbear.rodeo>

Made because controlling dozens of lightbulbs became otherwise imossible: it required infinite scrolling to find the right light or group.

This card allows instanteneously selecting and controlling dozens of lights on a 2D canvas.

[![Open your Home Assistant instance and open this repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=Mihonarium&repository=hass-spatial-lights-card)

# Spatial Lights Card for Home Assistant

The Spatial Lights Card lets you place many Home Assistant lights on a 2D canvas, making it easy to control arbitrary groups of entities with very few taps and little attention.

You can drag to draw a rectangle around lights, which you'll immediately be able to control as a group. You can toggle individual lights

Very useful when you have a lot of lights, and searching for the one you need by name and icon is tiresome; you can position the lights in a layout that corresponds to the physical room layout, making it easy to select the light you need. You can add a background image, e.g., with the room layout.

<img width="494" height="697" alt="image" src="https://github.com/user-attachments/assets/688ac67a-f58f-45e3-9917-88f6c1c4bb02" />


---

## Table of Contents

1. [Features](#features)
2. [Installation](#installation)
3. [Quick Start](#-quick-start)
6. [Usage Tips](#-usage)
5. [Configuration Reference](#-all-configuration-options)
7. [Custom Colors & Backgrounds](#-custom-colors--backgrounds)
8. [Visual Layout Options](#-visual-options)
9. [Troubleshooting](#troubleshooting)

---

## Features

- Interactive 2D layout to position lights exactly where they are in a room.
- Multi-select and batch control color, brightness, and temperature.
- Support for Scenes, Switches, and Input Booleans, customizable display colors for switches and scenes.
- Background image support (URL, size, blend modes).
- Optional default entity for whole-room adjustments.
- Toggleable floating/below controls to match your dashboard style.

---

## Installation

### Via HACS (Recommended)
1. [![Open your Home Assistant instance and open this repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=Mihonarium&repository=hass-spatial-lights-card)
2. Install the card and reload your browser when prompted.

### Manual Installation

```bash
# Copy file
cp hass-spatial-lights-card.js /config/www/

# Add to resources: open Settings → Dashboards → (three dots) → Resources to add via UI. Alternatively, add the following to configuration.yaml:
resources:
  - url: /local/hass-spatial-lights-card.js
    type: module

```

---

## 🎯 Quick Start

1. Install the resource using one of the methods above.
2. Edit a dashboard.
3. Choose **Add card → Spatial Lights Color Card**.

**You're all set!** 🎉

---

## 🎨 Usage

### Desktop
- **Click** to select a light.
- **Double-click** a light, switch, or scene to toggle/activate it.
- **Shift+Click** to add to the current selection.
- **Drag** to create a marquee selection (when nothing is selected).
- **Unlock** in settings to drag lights around the canvas. **Alt+Drag** a light to snap its position to the grid size.
- **Long click** to open the details.

### Mobile
- **Tap** to select a light.
- **Double-tap** a light, switch, or scene to toggle/activate it.
- **Drag** with an empty selection to select an area.
- **Long tap** to open the details.

> **Note:** If `switch_single_tap` is enabled, switches and scenes activate immediately on a single tap/click. To move them in this mode, you must unlock positions in settings first.

### Controls
- **Color wheel** — tap anywhere to set hue and saturation.
- **Brightness slider** — drag horizontally to set brightness. Tap to jump to value.
- **Temperature slider** — adjust white-temperature capable lights.
- **Default entity** — when configured, controls this entity if no light is selected.

### 💡 Tips

1. Click/tap away to deselect.
4. Add a Default Entity with all of a room's lights to control the whole room.
6. Add color presets to quickly turn the lights a favorite color.
7. Use live colors to easily set lights to colors already present in the room.
8. To see what lights are of a color among live colors/presets, hover mouse over it (or tap and hold that color on mobile).

---

## 📋 All Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `title` | string | `"Lights"` | Card title. |
| `entities` | list | **required** | Entities (lights, switches, input_booleans, scenes) to display. |
| `positions` | map | `{}` | Per-entity x/y positions from 0–100 (percentage). |
| `canvas_height` | number | `450` | Canvas height in pixels. |
| `grid_size` | number | `25` | Grid spacing in pixels when snapping. |
| `label_mode` | string | `"smart"` | Label generation mode (`smart`, `friendly_name`, `entity_id`). |
| `label_overrides` | map | `{}` | Map entity_id → custom label. |
| `color_overrides` | map | `{}` | Map entity_id → color string OR object (`state_on`, `state_off`). |
| `switch_on_color` | string | `"#ffa500"` | Default color for active switches. |
| `switch_off_color` | string | `"#2a2a2a"` | Default color for inactive switches. |
| `scene_color` | string | `"#6366f1"` | Default color for scenes. |
| `show_settings_button` | boolean | `true` | Display settings gear in card header. |
| `always_show_controls` | boolean | `false` | Always show color controls even when nothing selected. Use if you prefer persistent sliders that are always there even if nothing is selected and there's no default_entity. |
| `controls_below` | boolean | `true` | Render controls below (`true`) or floating over (`false`). |
| `default_entity` | string | `null` | Entity to control when nothing is selected. |
| `switch_single_tap` | boolean | `false` | Toggle switches/scenes with a single tap instead of selecting them. |
| `show_entity_icons` | boolean | `false` | Show MDI icons inside the light circles. |
| `icon_style` | string | `"mdi"` | Icon style (`mdi` or `emoji`). |
| `light_size` | number | `56` | Size of light circles in pixels (24-96). |
| `icon_only_mode` | boolean | `false` | Display lights as icons only (no filled circles). |
| `size_overrides` | map | `{}` | Per-entity size overrides (e.g., `light.lamp: 40`). |
| `icon_only_overrides` | map | `{}` | Per-entity icon-only mode overrides (e.g., `light.lamp: true`). |
| `background_image` | string/map | `null` | URL string or object `{url, size, position, blend_mode}`. |
| `color_presets` | list | `[]` | Hex color strings to show as quick-select circles (e.g., `["#ff0000", "#00ff00"]`). |
| `show_live_colors` | boolean | `false` | Show the current colors of your lights as additional preset circles. |
| `temperature_min` | number | `null` | Override minimum Kelvin for temperature slider. |
| `temperature_max` | number | `null` | Override maximum Kelvin for temperature slider. |

> ℹ️ **Label modes:** `smart` uses friendly names when available, falling back to entity IDs. Override individual entities with `label_overrides`.

---

## 🖌 Custom Colors & Backgrounds

### Global Colors
Customize the default appearance of non-light entities by setting the Switch On Color, Switch Off Color, and Scene Color.
<!--```yaml
switch_on_color: "#00ff00"
switch_off_color: "#ff0000"
scene_color: "#55aaff"
```-->


### Color Presets

Add quick-select color circles next to the color wheel so you can apply frequently used colors with a single tap.
<!--```yaml
color_presets:
  - "#ff0000"
  - "#00ff00"
  - "#0000ff"
  - "#ff8800"
  - "#e040fb"
```-->
<img height="171" alt="image" src="https://github.com/user-attachments/assets/e045c141-7206-4d0d-a8ad-af676cd2b2aa" />

<br/><br/>

Enable **Show Live Colors** to also display the current colors of your lights as preset circles. When hovering a preset (or long-pressing on mobile), the lights that currently have that color are highlighted on the canvas. If all controlled lights share the same color, the matching preset shows a subtle ring indicator.

<!--```yaml
color_presets:
  - "#ff0000"
  - "#00ff00"
show_live_colors: true
```-->

### Individual Overrides

Have a switch or some other entity that you want to have a specific color when it's on/off?

<img width="41" height="40" alt="image" src="https://github.com/user-attachments/assets/19080d4d-49a9-4f0a-9ead-47c25f61027b" />

Use Color Overrides. You can provide a single color (applied when "on") or specific colors for both states. (Above is the override with #02fae9 for state_on.)

<!--```yaml
color_overrides:
  # Simple string = On color
  scene.movie_night: "#a855f7"
  switch.kitchen_fan: "#00ff00"

  # Object = Specific state colors
  switch.hallway:
    state_on: "#ffffff"
    state_off: "#444444"
```-->

### Background Image
Add a floorplan or texture behind your lights.
```yaml
background_image:
  url: "/local/floorplan.png"
  size: "cover"      # or "contain", "100% 100%"
  position: "center"
  blend_mode: "overlay" # Optional CSS blend mode
```

### Light Size
Customize the size of light circles globally or per-entity.

<!--```yaml
# Global size (default is 56px)
light_size: 40

# Per-entity sizes
size_overrides:
  light.ceiling: 70    # Make ceiling light larger
  light.accent: 30     # Make accent light smaller
```-->

### Icon-Only Mode

Display lights as icons without the filled circle background. Icons show the light's color when on and remain visible (dimmed) when off.

Also experiment with Minimal UI.

<!--```yaml
# Enable for all lights
icon_only_mode: true

# Or per-entity
icon_only_overrides:
  light.ceiling: true      # Icon-only for ceiling
  switch.fan: true         # Icon-only for fan switch
  light.floor_lamp: false  # Keep filled circle for floor lamp
```-->

When icon-only mode is enabled:
- Icons are colored based on the light's state
- A subtle border ring shows the light's color when on
- Off lights remain visible with a dimmed appearance
- Great for cleaner layouts or when using background images

---

## 🎨 Visual Options

### Floating Controls (Default)
<!--```yaml
controls_below: false
```-->
- Controls appear over the canvas when lights are selected.
- Minimal overlay that hides automatically when nothing is selected.

### Controls Below the Canvas
<!--```yaml
controls_below: true
always_show_controls: true
```-->
- Controls remain visible below the layout for quick access.
- Ideal when you never want controls to cover the floor plan.

---

## Troubleshooting

### Controls not showing?
- Select at least one light.
- Or enable Always Show Controls.
- Or configure the Default Entity to control something when nothing is selected.

### Lights not visible on load?
- Reload the dashboard after updating the card.

### Other issues?
- [Submit the issue on GitHub](https://github.com/Mihonarium/hass-spatial-lights-card/issues/new).

---

## ToDo
- [ ] Think about adding arbitraryhe sensors display
- [ ] Think about adding arbitrary templates/HTML
- [ ] Fix the bug where too many preset/live lights on the desktop get displayed under the color wheel in a way that enlarges the color wheel area and makes the sliders smaller

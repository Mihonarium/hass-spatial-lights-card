Made because controlling dozens of lightbulbs became otherwise imossible: it required infinite scrolling to find the right light or group.

This card allows instanteneously selecting and controlling dozens of lights on a 2D canvas.

[![Open your Home Assistant instance and open this repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=Mihonarium&repository=hass-spatial-lights-card)

# Spatial Lights Card for Home Assistant

The Spatial Lights Card lets you place many Home Assistant lights on a 2D canvas, for example, corresponding to their physical locations, making it easy to control arbitrary groups of entities with very few taps and little attention.

You can drag to draw a rectangle around lights, which you'll immediately be able to control as a group. You can toggle individual lights

Very useful when you have a lot of lights, and searching for the one you need by name and icon is tiresome; you can position the lights in a layout that corresponds to the physical room layout, making it easy to select the light you need. You can add a background image, e.g., with the room layout.

<img width="494" height="697" alt="image" src="https://github.com/user-attachments/assets/688ac67a-f58f-45e3-9917-88f6c1c4bb02" />


---

## Table of Contents

1. [Features](#features)
2. [Installation](#installation)
3. [Quick Start](#-quick-start)
4. [Usage](#-usage) — Selecting, toggling, color wheel, sliders, presets, moving lights, keyboard shortcuts
5. [Configuration Reference](#-all-configuration-options)
6. [Custom Colors & Backgrounds](#-custom-colors--backgrounds)
7. [Visual Layout Options](#-visual-options)
8. [Troubleshooting](#troubleshooting)

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

### Selecting Lights

| Action | Desktop | Mobile |
|--------|---------|--------|
| Select a single light | Click | Tap |
| Add/remove from selection | Shift+Click, Ctrl+Click, or Cmd+Click | — |
| Select area (marquee) | Click and drag on empty canvas | Tap and drag on empty canvas |
| Add area to selection | Shift/Ctrl/Cmd + drag on empty canvas | — |
| Select all lights | Ctrl+A / Cmd+A | — |
| Deselect all | Click/tap empty canvas, or press Escape | Tap empty canvas |

When lights are selected, the color wheel, brightness slider, and temperature slider control all selected lights as a group. If you have a **default entity** configured, the controls affect that entity when nothing is selected.

### Toggling Lights On/Off

| Action | Desktop | Mobile |
|--------|---------|--------|
| Toggle a light | Double-click | Double-tap |
| Toggle a switch/scene | Double-click (or single click if `switch_single_tap` is on) | Double-tap (or single tap if `switch_single_tap` is on) |

> **Note:** If `switch_single_tap` is enabled, switches and scenes activate immediately on a single tap/click instead of being selected.

### Opening Light Details

| Action | Desktop | Mobile |
|--------|---------|--------|
| Open more-info panel | Long-click (~650 ms) or right-click | Long-press (~500 ms) |

The more-info panel is the standard Home Assistant entity dialog where you can see attributes, history, and settings.

### Color Wheel

- **Tap/click** on the mini color wheel to immediately apply that color to selected lights.
- **Long-press** the mini color wheel (400 ms on touch, 600 ms on mouse) to open a **full-screen color picker** with a magnifier for precise color selection.
  - Drag around the large wheel to preview colors in the magnifier.
  - Lift your finger / release the mouse to apply the color.
  - Close with the **Done** button, by clicking the backdrop, or by pressing **Escape**.

### Brightness & Temperature Sliders

- **Drag** horizontally along a slider to adjust the value smoothly.
- **Tap/click** anywhere on the slider track to jump to that value.
- The brightness slider ranges from 0–255 (displayed as a percentage).
- The temperature slider range depends on the light's capabilities (in Kelvin).
- On mobile, if you start scrolling vertically while touching a slider, the slider releases so you can scroll the page.

### Color Presets & Live Colors

- **Click/tap** a preset circle to apply that color to all selected lights.
- **Hover** over a preset (desktop) to temporarily highlight which lights on the canvas currently have that color.
- **Long-press** a preset (~300 ms, mobile) to highlight which lights have that color. Release to clear the highlight.
- When all selected lights share the same color as a preset, that preset shows a subtle active ring indicator.
- **Live colors** (when `show_live_colors` is enabled) show the colors currently in use by your lights, automatically deduplicated.
- **Live temperatures** appear as a separate group. A thin vertical separator line divides color presets from temperature presets when they are on the same row.

### Moving Lights on the Canvas

Lights are **locked** by default. To reposition them:

1. Open the card editor (pencil icon on the dashboard).
2. Toggle **Unlock Positions** in the card settings (or use the lock/unlock button if available).
3. Drag lights to their new positions.

| Action | Desktop | Mobile |
|--------|---------|--------|
| Move a light | Drag | Drag |
| Snap to grid | Hold **Alt** while dragging | — |
| Nudge selected lights | Arrow keys (moves 0.5% per press) | — |
| Fine nudge | Alt + Arrow keys (moves 1% per press) | — |
| Undo move | Ctrl+Z / Cmd+Z | — |
| Redo move | Ctrl+Y / Cmd+Shift+Z | — |

Position history stores up to 50 steps.

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+A / Cmd+A | Select all lights |
| Escape | Deselect all / close color wheel / close dialogs |
| Ctrl+Z / Cmd+Z | Undo position change |
| Ctrl+Y / Cmd+Shift+Z | Redo position change |
| Arrow keys | Nudge selected lights (when positions unlocked) |
| Alt + Arrow keys | Fine-nudge selected lights |

### Desktop vs Mobile Differences

- **Layout:** On screens wider than 768 px, controls use a two-column grid (color wheel + sliders side by side). On mobile (768 px or narrower), controls stack vertically.
- **Preset highlighting:** On desktop, hovering over a preset highlights matching lights. On mobile, you need to long-press (~300 ms) the preset.
- **Light size:** On mobile, light circles are capped at 50 px regardless of the configured `light_size`.
- **Floating controls:** On desktop, floating controls are centered. On mobile, they stretch edge-to-edge with padding.
- **Multi-select modifiers** (Shift/Ctrl/Cmd) are only available on desktop.

### 💡 Tips

1. Click/tap empty space on the canvas to deselect all lights.
2. Add a **Default Entity** containing all of a room's lights to control the whole room when nothing is selected.
3. Add **color presets** to quickly apply favorite colors with a single tap.
4. Enable **live colors** to see and reuse colors already present in the room.
5. Hover over a preset (or long-press on mobile) to see which lights currently have that color.
6. Use **Ctrl+A** to quickly select all lights for batch adjustments.
7. Right-click (or long-press on mobile) any light to open its full detail panel.

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

## About the design
The design was somewhat inspired by the Philips Hue light controls, and thinking hard about how to improve over it. I liked about the Philips Hue app the ability to easily grab many lights and make them arbitrary colors, including multiple lights at the same time; and making many lights the same color. However, picking the specific light was still fairly difficult, if you have a lot of lights.

This card solves all of the problems: identifying lights by their position in the physical space is much easier than identifying them by their position on the color wheel or finding them by name.

This allows very fast and easy setting of arbitrary groups of lights to specific color/temperature/brightness; there’s a mode that shows existing colors and presets to easily sync arbitrary lights to the same color.

It’s current state is an enormous improvement over the default ways to have smart home dashboards, which usually have 1D lists with individual controls for each light (and each pre-defined light group) which either take space or need to be opened and are also hard to find if you have a lot of lights.

The card allows placing lights and other entities on a 2D canvas to easily control arbitrary lights/groups of lights (that's always a nightmare once you have dozens of devices).

Lights can be placed corresponding to their physical location and can be selected in arbitrary groups by dragging a selection box over them.

The card also supports switches (they can be toggled by a double or a single tap depending on a setting) and binary sensors (it can display on/off states with arbitrary colors).

It also has color presets (for quickly setting lights to a specific color) and a live color mode (for quickly setting ligths to a color that some lights in the card already have).

This card made turn dozens of lights to nice colors in arbitrary ways much easier.

## ToDo
- [ ] Think about adding arbitrary sensors display
- [ ] Think about adding arbitrary templates/HTML
- [ ] Color effects (not just colors) among presets (with icons?)
- [ ] Think about placing links to other Home Assistant things on the canvas
- [ ] Add a setting for toggling lights with a single tap
- [ ] Fix the bug where too many preset/live lights on the desktop get displayed under the color wheel in a way that enlarges the color wheel area and makes the sliders smaller
- [ ] Fix the bug that on clearing the picture and picking a new one, the previous picture settings don't apply to the new picture
- [ ] Non-interactive elements should not be selectable

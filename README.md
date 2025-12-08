[![Open your Home Assistant instance and open this repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=Mihonarium&repository=hass-spatial-lights-card)

# Spatial Lights Card for Home Assistant

The Spatial Lights Card lets you place many Home Assistant lights on a 2D canvas, making it easy to control arbitrary groups of lights with few taps and little attention.

Very useful when you have a lot of lights, and searching the one you need by name and icon is tiresome; you can position all the lights in a layout that corresponds to the physical room layout, making it easy to select the light you need.

You can also drag to draw a rectangle around lights, which you'll immediately be able to control as a group.

<img width="758" height="891" alt="image" src="https://github.com/user-attachments/assets/2801dc44-5611-446b-94d6-74e682b93678" />


---

## Table of Contents

1. [Features](#features)
2. [Installation](#installation)
3. [Quick Start](#-quick-start)
4. [Configuration Reference](#-all-configuration-options)
5. [Usage Tips](#-usage)
6. [Common Workflows](#-common-workflows)
7. [Visual Layout Options](#-visual-options)
8. [Locking & Positioning](#-lockunlock)
9. [Example Setups](#-example-setups)
10. [Troubleshooting](#troubleshooting)

---

## Features

- Interactive 2D layout to position lights exactly where they are in a room.
- Multi-select and batch control color, brightness, and temperature.
- Optional default entity for whole-room adjustments.
- Toggleable floating/below controls to match your dashboard style.
- Built-in position locking and export tools for hassle-free editing.

---

## Installation

### Via HACS (Recommended)
1. [![Open your Home Assistant instance and open this repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=Mihonarium&repository=hass-spatial-lights-card)
2. Install the card and reload your browser when prompted.

### Manual Installation
```bash
# Copy file
cp hass-spatial-lights-card.js /config/www/

# Add to resources (configuration.yaml or UI)
resources:
  - url: /local/hass-spatial-lights-card.js
    type: module
```

---

## 🎯 Quick Start

1. Install the resource using one of the methods above.
2. Open **Settings → Dashboards → (three dots) → Edit dashboard**.
3. Choose **Add card → Custom: Spatial Lights Card** (or **Manual** and paste YAML).

### Minimal Setup
```yaml
type: custom:spatial-light-color-card
title: Living Room
entities:
  - light.ceiling
  - light.floor_lamp
```

### With Always-Visible Controls
```yaml
type: custom:spatial-light-color-card
title: Living Room
always_show_controls: true
controls_below: true
entities:
  - light.ceiling
  - light.floor_lamp
```

### With Default Entity (Control All)
```yaml
type: custom:spatial-light-color-card
title: Living Room
default_entity: light.living_room_all  # Controls this when nothing selected
entities:
  - light.ceiling_1
  - light.ceiling_2
  - light.floor_lamp
```

### Production Setup (Locked, No Settings)
```yaml
type: custom:spatial-light-color-card
title: Living Room
show_settings_button: false
always_show_controls: true
controls_below: true
default_entity: light.living_room_all
entities:
  - light.ceiling_1
  - light.ceiling_2
positions:
  light.ceiling_1:
    x: 30.0
    y: 25.0
  light.ceiling_2:
    x: 70.0
    y: 25.0
```

---

## 📋 All Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `title` | string | `"Lights"` | Card title |
| `entities` | list | **required** | Light entities to display |
| `positions` | map | `{}` | Per-entity x/y positions from 0–100 (percentage) |
| `canvas_height` | number | `450` | Canvas height in pixels |
| `grid_size` | number | `25` | Grid spacing in pixels when snapping |
| `label_mode` | string | `"smart"` | Label generation mode (`smart`, `friendly_name`, `entity_id`) |
| `label_overrides` | map | `{}` | Map entity_id → custom label |
| `show_settings_button` | boolean | `true` | Display settings gear in card header |
| `always_show_controls` | boolean | `false` | Always show color controls even when nothing selected |
| `controls_below` | boolean | `true` | Render controls below (`true`) or floating over (`false`) |
| `default_entity` | string | `null` | Entity to control when nothing is selected |
| `background_image` | string/map | `null` | Optional canvas background image. Pass a URL string or map (`url`, optional `size`, `position`, `repeat`, `blend_mode`). |

> ℹ️ **Label modes:** `smart` uses friendly names when available, falling back to entity IDs. Override individual entities with `label_overrides`.

---

## 🎨 Usage

### Desktop
- **Click** to select a light.
- **Shift+Click** to add to the current selection.
- **Drag** to create a marquee selection (when nothing is selected).
- **Unlock** in settings to drag lights around the canvas.
- **Alt+Drag** a light to snap its position to the grid size.

### Mobile
- **Tap** to select a light.
- **Long press** (~500 ms) to add to the selection.
- **Drag** with an empty selection to select an area.
- **Unlock** in settings to drag lights.

### Controls
- **Color wheel** — tap anywhere to set hue and saturation.
- **Brightness slider** — drag horizontally or vertically (depending on theme) to set brightness.
- **Temperature slider** — adjust white-temperature capable lights.
- **Default entity** — when configured, controls this entity if no light is selected.

---

## 💡 Common Workflows

### Designing a Layout
1. Add all relevant light entities to the card.
2. Click the **⚙** icon and disable **Lock positions**.
3. Drag each light to match its real-world location.
4. Optional: Enable **Snap to grid** (Alt/Option while dragging) for perfect alignment.
5. Click **Export configuration** to capture current positions into YAML.
6. Paste the exported YAML into your dashboard configuration.
7. Re-enable **Lock positions** for everyday use.

### Daily Use
1. Select the light(s) you want to control.
2. Adjust color, brightness, and temperature from the controls.
3. Click/tap away to deselect, or rely on `default_entity` to control the whole room.

### Mobile Tips
1. Tap to select, long-press to extend the selection.
2. Drag the selection rectangle for quick grouping.
3. Use `always_show_controls: true` if you prefer persistent sliders on small screens.

---

## 🎨 Visual Options

### Floating Controls (Default)
```yaml
controls_below: false
```
- Controls appear over the canvas when lights are selected.
- Minimal overlay that hides automatically when nothing is selected.

### Controls Below the Canvas
```yaml
controls_below: true
always_show_controls: true
```
- Controls remain visible below the layout for quick access.
- Ideal when you never want controls to cover the floor plan.

### Floorplan Background Image
```yaml
background_image:
  url: https://example.com/floorplan.png
  size: cover         # optional (e.g., contain, 80%)
  position: center    # optional
  repeat: no-repeat   # optional
  blend_mode: normal  # optional, e.g., multiply
```
- Adds a custom image beneath the lights while keeping the grid overlay on top.
- Use `blend_mode` to fine-tune how the image and base colors mix.

---

## 🔒 Lock/Unlock

### Default: Locked ✅
- Prevents accidental movement of light positions.
- Safe for daily dashboards.
- Full control access without editing the layout.

### To Rearrange
1. Click the **⚙** icon (settings).
2. Toggle **Lock positions** off.
3. Drag lights to new coordinates.
4. Toggle **Lock positions** back on when finished.
5. Export the updated YAML so the layout persists.

---

## 🎯 Example Setups

### Home Theater
```yaml
type: custom:spatial-light-color-card
title: Theater
canvas_height: 400
show_settings_button: false
always_show_controls: true
controls_below: true
default_entity: light.theater_all
entities:
  - light.screen_backlight
  - light.ceiling_cans
  - light.floor_accents
```

### Bedroom
```yaml
type: custom:spatial-light-color-card
title: Bedroom
canvas_height: 450
always_show_controls: false
controls_below: false
entities:
  - light.bedside_left
  - light.bedside_right
  - light.ceiling
```

### Office
```yaml
type: custom:spatial-light-color-card
title: Office
show_settings_button: false
always_show_controls: true
default_entity: light.office_all
entities:
  - light.desk
  - light.bookshelf
  - light.overhead
```

---

## Troubleshooting

### Lights not visible on load?
- Confirm Home Assistant reports the entities as available.
- Check the browser console for JavaScript errors (Developer Tools → Console).
- Reload the dashboard after updating the card.

### Can't move lights?
- Click the **⚙** icon and toggle **Lock positions** off.
- Positions are locked by default to prevent accidental drags.

### Multi-select not working on mobile?
- Hold for ~500 ms (long press) to add lights to the selection.
- Haptic feedback (if available) indicates selection.
- Then tap additional lights.

### Controls not showing?
- Select at least one light.
- Or enable `always_show_controls: true`.
- Or configure `default_entity` to control something when nothing is selected.

---

**You're all set! Enjoy your perfectly designed light controller.** 🎉

# HASS-Spatial-Lights-Card
Spatial Light Card for Home Assistant


## Installation

### Via HACS (Recommended)
1. In Home Assistant, go to **HACS → Frontend**.
2. Choose **Custom repositories** and add this repo (`https://github.com/Mihonarium/hass-spatial-lights-card`) as a **Lovelace** type repository while it is pending publication, or search for **Spatial Lights Card** once it is listed.
3. Install the card and reload your browser when prompted.

### Manual Installation
```bash
# Copy file
cp hass-spatial-lights-card.js /config/www/

# Add to resources
resources:
  - url: /local/hass-spatial-lights-card.js
    type: module
```

---

## 🎯 Quick Start

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
| `title` | string | "Lights" | Card title |
| `entities` | list | required | Light entities |
| `positions` | map | {} | Light positions (x, y) |
| `canvas_height` | number | 450 | Canvas height in pixels |
| `grid_size` | number | 25 | Grid size in pixels |
| `label_mode` | string | "smart" | Label generation mode |
| `label_overrides` | map | {} | Custom labels per entity |
| `show_settings_button` | boolean | true | Show settings gear |
| `always_show_controls` | boolean | false | Always show color controls |
| `controls_below` | boolean | true | Controls below canvas |
| `default_entity` | string | null | Entity to control when nothing selected |

---

## 🎨 Usage

### Desktop
- **Click** to select light
- **Shift+Click** to add to selection
- **Drag** to select area (if nothing selected first)
- **Unlock** in settings to drag lights
- **Alt+Drag** to snap to grid

### Mobile
- **Tap** to select light
- **Long press** (500ms) to add to selection
- **Drag** to select area
- **Unlock** in settings to drag lights

### Controls
- **Color Wheel** - Click to set color
- **Brightness** - Drag slider
- **Temperature** - Drag slider
- **Default Entity** - Controls this when nothing selected

---

## 💡 Common Configurations

### 1. Quick Control Panel
```yaml
# Always visible, below canvas, control all lights
always_show_controls: true
controls_below: true
default_entity: light.all_living_room
```
**Use case:** Daily light control, no position changes needed

### 2. Spatial Controller
```yaml
# Select individual lights, floating controls
always_show_controls: false
controls_below: false
```
**Use case:** Precise control of individual lights

### 3. Production Setup
```yaml
# Locked, clean, always accessible
show_settings_button: false
always_show_controls: true
controls_below: true
default_entity: light.room_group
```
**Use case:** Wall tablet, kiosk mode, family use

### 4. Design Mode
```yaml
# Unlocked, settings visible
show_settings_button: true
always_show_controls: false
# Don't set positions yet
```
**Use case:** Initial setup, arranging lights

---

## 🔧 Workflow

### Initial Setup
1. Add card with `entities` only
2. Lights appear in auto-layout
3. Click ⚙ → Unlock positions
4. Drag lights to real positions
5. Click ⚙ → Export configuration
6. Copy YAML and paste into config
7. Optional: Set `show_settings_button: false`

### Daily Use
1. Select light(s) you want to control
2. Adjust color/brightness
3. Click away to deselect
4. Or use `default_entity` to control all

### Mobile Use
1. Tap to select
2. Long press to add more
3. Adjust with sliders
4. Tap away to deselect

---

## 🎨 Visual Options

### Floating Controls (Default)
```yaml
controls_below: false
```
- Appear over canvas when lights selected
- Clean, minimal
- Auto-hide when nothing selected

### Below Controls
```yaml
controls_below: true
always_show_controls: true
```
- Always visible below canvas
- Never cover lights
- Quick access

---

## 🔒 Lock/Unlock

### Default: Locked ✅
- Can't accidentally move lights
- Safe for daily use
- Can still select and control

### To Rearrange:
1. Click ⚙ (settings)
2. Toggle "Lock Positions" off
3. Drag lights
4. Toggle back on when done
5. Export updated YAML

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
- Make sure `hass` is connected
- Check browser console for errors
- This should be fixed in final version

### Can't move lights?
- Click ⚙ → Toggle "Lock Positions" off
- Positions locked by default now

### Multi-select not working on mobile?
- Hold for 500ms (long press)
- Should feel vibration
- Then tap more lights

### Controls not showing?
- Select a light, or
- Set `always_show_controls: true`, or
- Set `default_entity` to control something

---

**You're all set! Enjoy your perfectly designed light controller.** 🎉

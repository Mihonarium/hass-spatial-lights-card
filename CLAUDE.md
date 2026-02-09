> Work in Progress! The following might change at any moment.

## Project Structure Overview
Show less
**Single-File Architecture**: The entire card is bundled into `/home/user/hass-spatial-lights-card/hass-spatial-lights-card.js` (4,828 lines). It's a Web Component that extends `HTMLElement` called `SpatialLightColorCard`.
**Key Components**:
- **Main Class**: `SpatialLightColorCard extends HTMLElement`
- **Configuration**: Accepts YAML config with entities, positions, colors, presets
- **State Management**: Selection tracking, drag state, control values, animation frames
- **Rendering**: Uses `shadowRoot.innerHTML` for template-based rendering with embedded styles
---
## 1. Slider Controls Rendering
**Location**: Lines 1381-1435 (Two control modes)
### Floating Controls (`_renderControlsFloating`)
- **Line 1390-1406**: Renders controls that appear over the canvas
- Structure uses CSS Grid: 2 columns × 2 rows
- **Column layout**:
  - Column 1: Color wheel (mini canvas, 128px)
  - Column 2: Sliders (brightness & temperature)
### Below Controls (`_renderControlsBelow`)
- **Line 1409-1435**: Same content but positioned below canvas
- Mobile layout at line 1152-1170: Transforms to flexbox with `flex-wrap: wrap`
### Slider Structure
- **HTML**: Lines 1394, 1398
  ```html
  <input type="range" class="slider" id="brightnessSlider" min="0" max="255" />
  <input type="range" class="slider temperature" id="temperatureSlider" />
  ```
- **Styling**: Lines 1065-1126 define slider appearance with CSS custom properties
  - `--slider-percent`: Controls visual fill percentage
  - `--slider-ratio`: Normalized value (0-1)
  - `--slider-fill`: Color gradient for brightness; temperature has warm-to-cool gradient
### Slider Gesture Binding
- **Lines 1520-1604** (`_bindSliderGesture`): Advanced pointer handling
  - `pointerdown`: Capture and immediate value update via `_applyPointerValue`
  - `pointermove`: Follows finger, detects vertical scroll to prevent interference
  - `pointerup/pointercancel`: Commits value change via `_handleBrightnessChange()` or `_handleTemperatureChange()`
  - Supports both keyboard (input/change events) and touch/mouse
### Value Updates
- **Lines 3018-3074** (`_handleBrightnessInput`, `_handleTemperatureChange`):
  - Brightness: 0-255 range → converts to percentage
  - Temperature: Kelvin value → calls `light.turn_on` service with `color_temp` (converted to mireds)
### Visual Update Mechanism
- **Lines 1508-1518** (`_updateSliderVisual`): Updates CSS variables on slider elements
- **Lines 1483-1505** (`_updateControlValues`): Updates both value and fill color based on controlled entity state
---
## 2. Color Presets & Live Colors Rendering
**Location**: Lines 2573-2677
### Color Presets Flow
```
_renderPresetsContent() [2647]
├─ _renderColorPresets() [2573]      → Config presets + live colors
└─ _renderTemperaturePresets() [2628] → Live temperature colors
    ├─ separator [2653]
```
### Color Presets (`_renderColorPresets`)
- **Lines 2573-2608**:
  1. Fetches live colors via `_getLiveColors()` [2357-2386]
  2. Deduplicates against config presets (RGB distance tolerance = 30)
  3. Renders config presets first, then filtered live colors
  4. Each preset is `<div class="color-preset">` with:
     - `data-preset-color`: Hex color
     - `data-preset-rgb`: RGB array (for live colors)
     - `data-preset-entities`: Comma-separated entity list for highlighting
     - Active state indicator ring when all selected lights share that color
### Live Colors Extraction
- **`_getLiveColors()`** [2357-2386]:
  - Iterates all entities with `state === 'on'`
  - Filters for RGB color modes: `hs`, `rgb`, `xy`, `rgbw`, `rgbww`
  - Skips lights in `color_temp` mode (excludes temperature-only colors)
  - Groups similar colors using RGB distance formula: `√(dr² + dg² + db²)` with tolerance 30
  - Returns: `{ hex, rgb, entities }`
### Temperature Presets (`_renderTemperaturePresets`)
- **Lines 2628-2645**:
  - Only renders if `show_live_colors: true`
  - Calls `_getLiveTemperatures()` [2388-2410]
  - Groups lights by color_temp mode with ±100K tolerance
  - Converts Kelvin → RGB for color display
  - Shows temperature label on hover
### Separator Line
- **Lines 2651-2657**: Adds `<div class="preset-separator">` between color and temp presets
- **CSS** [1021-1024]: 1px vertical line, 20px tall, 3px margin
- **Visibility Logic** [2659-2677] (`_updateSeparatorVisibility`):
  - Measures layout using `getBoundingClientRect()`
  - **Hides separator if color and temp presets are NOT on same row**
  - Threshold: `> 2px` vertical distance = different rows → hide
### Preset Interaction
- **Handlers** [2454-2512] (`_bindPresetHighlight`, `_bindPresetHandlers`):
  - **Desktop**: `pointerenter/pointerleave` (mouse-only via `pointerType check`)
  - **Mobile**: 300ms `pointerdown` hold to highlight entities, release to clear
  - Highlight class: `.preset-highlight` on matching lights (brightens them)
  - Click applies color: `light.turn_on` with `rgb_color`
---
## 3. Mobile vs Desktop Layouts
**Media Query Breakpoint**: `@media (max-width: 768px)` at **Line 1152**
### Desktop Layout (> 768px)
```
CSS Grid: 2 columns × 2 rows
┌─────────────────────────────────────┐
│ Color Wheel │ Brightness Slider    │ ← grid-row: 1
│ (128px)     │ Temperature Slider   │
└─────────────────────────────────────┘
│ (col 2)     │ Presets (wrap flex)  │ ← grid-row: 2
└─────────────────────────────────────┘
```
- **Color Wheel**: `grid-column: 1; grid-row: 1/3` (spans 2 rows)
- **Sliders**: `grid-column: 2; grid-row: 1` (flexbox column)
- **Presets**: `grid-column: 2; grid-row: 2` (flexbox row wrap)
- **Positioning**: Floating at bottom-center or below canvas
### Mobile Layout (≤ 768px)
```
Flexbox Row Wrap (Vertical Stack)
┌──────────┐
│ Wheel    │ ← order: 1
├──────────┤
│ Presets  │ ← order: 2 (max-width: calc(100% - 140px))
├──────────┤
│ Sliders  │ ← order: 3, flex: 1 1 100% (full width)
└──────────┘
```
- **Key changes**:
  - `display: flex; flex-wrap: wrap; justify-content: center; gap: 12px`
  - Presets: `max-width: calc(100% - 140px)` (avoid covering controls)
  - Sliders: Full width (`flex: 1 1 100%`)
  - Light size capped: `Math.min(light_size, 50)px`
**Floating vs Below**:
- **Floating** (default): `position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%)`
  - Mobile: `left: 16px; right: 16px; width: auto; transform: none` (respects screen edges)
- **Below** (`controls_below: true`): Rendered after canvas div, takes full width
---
## 4. Separator Line Between RGB and Temperature
**Location**: Lines 1021-1024 (CSS) + 2651-2657 (HTML generation) + 2659-2677 (visibility logic)
### CSS Definition
```css
.preset-separator {
  width: 1px;                      /* Vertical line */
  height: 20px;                    /* Centered in preset row */
  background: rgba(255,255,255,0.12);  /* Subtle semi-transparent */
  margin: 0 3px;                   /* Space around separator */
  flex-shrink: 0;                  /* Prevent shrinking */
  align-self: center;              /* Center vertically in flex row */
}
```
### Generation Logic
- Generated in `_renderPresetsContent()` only if BOTH conditions true:
  - `colorHtml` exists (config presets or live colors in RGB mode)
  - `tempHtml` exists (live temperatures with `show_live_colors: true`)
### Smart Visibility Control
- **Purpose**: Hide separator when presets wrap to different rows (mobile reflow)
- **Algorithm** [2659-2677]:
  1. Measure `previousElementSibling` (last color preset) top position
  2. Measure `nextElementSibling` (first temp preset) top position
  3. If `|topPrev - topNext| > 2px` → different rows → `display: none`
  4. Called after preset DOM updates via `requestAnimationFrame`
---
## 5. Key Rendering Flow
```
setConfig(config)
  ↓
_renderAll()
  ├─ _renderHeader()
  ├─ _renderLightsHTML() [lines 1308-1379]
  ├─ _renderControlsFloating() OR _renderControlsBelow()
  │   └─ _renderPresetsContent()
  │       ├─ _renderColorPresets()
  │       │   └─ _getLiveColors()
  │       └─ _renderTemperaturePresets()
  │           └─ _getLiveTemperatures()
  ├─ Cache element refs (_els.*)
  ├─ _attachEventListeners()
  │   ├─ Color wheel pointer events (1726-1830)
  │   ├─ Preset handlers (1833)
  │   └─ Slider gestures (1834-1844)
  └─ drawColorWheel()
```
---
## 6. Data Flow for Control Values
```
User interaction (slider drag, color wheel click)
  ↓
_bindSliderGesture() or color wheel handler
  ↓
_applyPointerValue() [1606-1627] → calculates value from pointer position
  ↓
_updateSliderVisual() [1508-1518] → updates CSS variables
  ↓
_handleBrightnessChange()/_handleTemperatureChange() [3029-3074]
  ↓
_getControlledEntities() [601-609] → gets selected or default entity
  ↓
hass.callService('light', 'turn_on', { entity_id, brightness/color_temp })
  ↓
State update from Home Assistant
  ↓
_updateControlValues() [1470-1506] → syncs UI to new state
```
---
## File Locations Summary
| Component | Lines | Notes |
|-----------|-------|-------|
| Class definition | 1-90 | Properties & constructor |
| Config parsing | 94-199 | setConfig() method |
| Control context | 601-715 | Averaging light states |
| Main render | 718-785 | _renderAll() orchestration |
| CSS styles | 787-1237 | Embedded in _styles() |
| Slider controls HTML | 1381-1435 | Two layout modes |
| Light circles HTML | 1308-1379 | Individual light elements |
| Brightness handling | 3018-3045 | Input + change events |
| Temperature handling | 3047-3074 | Input + change events |
| Color presets render | 2573-2608 | Config + live colors |
| Temperature presets | 2628-2645 | Live temps only |
| Separator logic | 2651-2677 | Visibility management |
| Preset binding | 2454-2512 | Hover/long-press handlers |
| Slider gestures | 1520-1604 | Pointer event handling |
| Event attachment | 1695-1845 | All event listeners |
| Live colors extract | 2357-2386 | From entity states |
| Live temps extract | 2388-2410 | Temperature grouping |
This architecture provides a highly responsive, touch-friendly control card with smart layout adaptation and real-time state synchronization.

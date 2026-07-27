> Work in Progress! The following might change at any moment.

## Project Structure Overview

**Single-file architecture.** The whole card lives in `/home/user/hass-spatial-lights-card/hass-spatial-lights-card.js`. It's a Web Component that extends `HTMLElement` (`class SpatialLightColorCard`), plus a sibling editor (`class SpatialLightColorCardEditor`).

> ℹ️ Anchors below are **function/identifier names** rather than line numbers — line numbers drift constantly. Use `grep -n` to jump to a name (e.g. `grep -n '_renderAll' hass-spatial-lights-card.js`).

**Key concepts:**
- `setConfig(config)` — Lovelace contract; normalizes config and re-renders if `hass` is set.
- `set hass(hass)` — Lovelace contract; diffs `prev.states` vs `next.states` against the config's entity set (`_isRelevantHassChange`) and runs `updateLights()` only when something relevant changed. First call goes through `_renderAll()`.
- `_renderAll()` — destructive: writes the whole `shadowRoot.innerHTML`, caches element refs, calls `_attachEventListeners()`. Calls `_cancelActiveInteractions()` first so an in-flight gesture commits its pending value before the DOM is wiped.
- `updateLights()` — non-destructive: walks each `.light` and toggles classes / sets styles based on current state (color, on/off, selected, unavailable). Drives `_updateControlValues`, `_refreshColorPresets`, `_updateAllGlows`, `_repositionLabels`.

---

## 1. Slider Controls Rendering

**Renderers:** `_renderControlsFloating(visible, controlContext)` and `_renderControlsBelow(controlContext)`. Both emit the same children: a 256×256 mini color wheel canvas, two `<input type="range">` sliders (brightness 0-255, temperature in `tempRange.min..max`), and the presets area.

**Layout modes:**
- Desktop (`@media (min-width: 769px)`): CSS Grid 2×2. Color wheel `grid-column: 1; grid-row: 1/3`; sliders top-right; presets bottom-right wrap.
- Mobile (`@media (max-width: 768px)`): flex-wrap row. Wheel order 1, presets order 2 with `max-width: calc(100% - 140px)`, sliders order 3 at full width.
- Floating vs below: `controls_below: true` (default) renders the controls block after the canvas; otherwise they're absolutely positioned over the canvas with mobile-aware insets.

**Slider gesture (`_bindSliderGesture`):** Pointer-down captures and immediately calls `_applyPointerValue(el, clientX)`. Pointermove follows the finger, with a 6 px / `dy > dx` heuristic that releases capture and reverts the value when the user is actually trying to scroll the page. Pointerup commits via `_handleBrightnessChange()` or `_handleTemperatureChange()`. The active gesture is recorded in `this._activeSliderGesture` so `_updateControlValues` skips clobbering the value while the user's finger is down. Keyboard-driven `change` events commit through `_scheduleSliderCommit` (150 ms trailing debounce).

**Service-call throttling:** Live mouse drags on the mini wheel go through `_applyColorWheelSelectionLive` (leading+trailing throttle, ~7 calls/sec); the pointerup commit calls `_applyColorWheelSelection` directly after `_cancelLiveWheelThrottle()` so a stale trailing color never lands after the final one.

**Theming:** `_themeTokens()` emits the `:host` CSS custom properties per `theme_mode` (`auto` maps HA theme variables with the original dark palette as fallbacks and derives elevation surfaces via `color-mix`; `dark`/`light` are fixed palettes), then appends user `theme.*` overrides. In auto mode without a `card_background` override, the `ha-card` background is NOT overridden so native theme styling (incl. glass backdrop-filter) applies. All components consume tokens only — never hardcoded colors.

**Visual updates:**
- `_updateSliderVisual(el)` — sets `--slider-percent` / `--slider-ratio` from `value`/`min`/`max`.
- `_updateControlValues(controlContext)` — full sync to averaged state, plus capability gating via `_getControlCapabilities()` (toggles `disabled` attribute on sliders, `.disabled` on color wheel, `.no-rgb-support`/`.no-temp-support`/`.no-brightness-support` on the controls container). The temperature slider's warm-to-cool gradient is a static CSS background — it's a visual affordance, not a precise color readout.

---

## 2. Color Presets & Live Colors

**Flow:** `_renderPresetsContent()` → `_renderColorPresets()` + (separator) + `_renderTemperaturePresets()` + `_renderEffectPresets()`.

**Color presets (`_renderColorPresets`):**
1. `_getLiveColors()` walks `state === 'on'` entities, filters by `color_mode` ∈ `RGB_COLOR_MODES`, deduplicates with `_rgbDistance() < COLOR_TOLERANCE` (constants on the class).
2. Filters live colors against config presets so config wins on collision.
3. Each preset is a focusable `<div role="button" tabindex="0">` carrying `data-preset-color`, optionally `data-preset-rgb`, and `data-preset-entities`.

**Active state:** `_getActivePresetColor()` returns the unique RGB shared by all controlled lights (within tolerance), or null. The preset whose RGB matches gets `.active`.

**Temperature presets (`_renderTemperaturePresets`):** Only emitted if `show_live_colors: true`. `_getLiveTemperatures()` groups lights with `color_mode === 'color_temp'` by ±`TEMP_TOLERANCE` Kelvin. The swatch is `_kelvinToRgb(kelvin)` (Tanner Helland, clamped to 1000-40000 K).

**Separator:** A 1×20 px div between RGB and temp presets. `_updateSeparatorVisibility()` checks via `getBoundingClientRect()` whether the previous color preset and the next temp preset are on the same row, and hides the separator otherwise.

**Preset interaction:** `_bindPresetHighlight(el)` and `_bindPresetHandlers()`. Mouse hover highlights matching lights via `pointerenter`/`pointerleave`; touch uses a 300 ms long-press to highlight, then clears on `pointerup`. Click applies via `_applyColorWheelSelection(rgb)` / `_applyTemperaturePreset(kelvin)` / `_applyEffectPreset(effect)`. Keyboard Enter/Space activates from `_handleKeyDown` → `composedPath()` lookup.

---

## 3. Light Rendering

**`_renderLightsHTML()`** maps over `_config.entities`, renders each as:

```html
<div class="light {state} {selected} {iconOnly} {unavailable}"
     style="left:Px%; top:Px%; ..."
     data-entity="..." tabindex="0" role="button"
     aria-label="..." aria-pressed="..." aria-disabled="...">
  <div class="light-glow"></div>?            <!-- if glow enabled -->
  <ha-icon ...>?                              <!-- if icons -->
  <div class="light-label">...</div>
  <div class="light-status-badge">?</div>?    <!-- if unavailable -->
</div>
```

**`updateLights()`** does in-place sync without rebuilding the DOM: state class, color, selection, and the `unavailable` class + badge are added/removed lazily.

**Color resolution:** `_resolveEntityColor(id, isOn, attributes)` consults `color_overrides`, then domain-specific defaults (`switch_on_color`/`switch_off_color`, `binary_sensor_*_color`, `scene_color`), then `attributes.rgb_color`, with `'#ffa500'` fallback for unknown.

---

## 4. Selection & Interaction State Machine

**Pointer events (`_attachEventListeners`):** All canvas pointer events flow into `_onPointerDown` / `_onPointerMove` / `_onPointerUp` / `_onPointerCancel`. `_handleCanvasContextMenu` opens more-info on right-click and clears any pending long-press.

**Modes:**
- Locked (default `_lockPositions = true`): tap → select / toggle (per `switch_single_tap`); 500 ms long-press → more-info. The canvas gets `touch-action: pan-y pinch-zoom` (class `touch-scroll`, gated by `canvas_touch_scroll`) so vertical swipes scroll the page.
- Edit positions (`_editPositionsMode`): tap → select; drag → reposition; arrow keys nudge. This is **editor-session state, never config**: the editor broadcasts `spatial-card-edit-mode` window events (and answers `spatial-card-preview-hello` from recreated preview cards); only a card inside `hui-card-preview` (`_isInsideEditorPreview`) honors them. Legacy `_edit_positions`/`_editor_id` keys in saved configs are ignored by the card and stripped by the editor.
- Rubber-band: a pointerdown on empty canvas arms `_selectionStart`/`_selectionPointerId`; the `.selection-box` materializes only after 5 px of movement, hit-testing is rAF-coalesced and diffed, and a completed tap (not pointerdown) is what deselects. Touch ownership is decided in JS, not by touch-action: the canvas is `touch-action: auto` (class `touch-scroll`) and `_handleCanvasTouchMove` (non-passive) rules on the first cancelable touchmove — movement steeper than ~55° from horizontal is declined to the browser (native scroll → pointercancel, selection kept, box never created thanks to a touch gate on box creation), anything else claims `_selectionTouchClaim = 'select'` and preventDefaults every subsequent touchmove so the marquee can then travel in any direction. A ~300 ms still hold (`_selectionHoldTimer`) claims 'select' outright for deliberately vertical box drags; `_handleCanvasContextMenu` swallows Android's ~500 ms long-press contextmenu while claimed.
- Preset hold-to-preview sets `_suppressPresetClick` so the synthesized click on release never applies the preset.

**Cancellation:** `_cancelActiveInteractions()` is the single sink for "abort everything." It releases capture, clears `_dragState`, all timers, magnifier state, color-wheel gesture, and commits any pending slider value. It's called from `_onPointerCancel`, `disconnectedCallback`-equivalent (via `_cancelActiveInteractions`), `visibilitychange` (when `document.hidden`), `window.blur`, and at the top of `_renderAll`.

---

## 5. Service Calls

All `light.turn_on` calls are routed through `_getServiceTargets(controlled, capability)`, which:
- filters to `light.*` entities (no `light.turn_on` on switches/scenes),
- skips unavailable entities,
- intersects with `supported_color_modes` for `'rgb'` / `'color_temp'` / `'brightness'`.

The result is sent in a single batched call (`entity_id: [array]`) so platforms (Hue, Z2M, deCONZ) can sync the bulbs together. Promise rejections are logged via `console.warn` rather than swallowed silently.

`_toggleEntity(entity)` handles tap-toggle: domain-aware (`scene.turn_on` for scenes, `switch.turn_on/off` for switches, etc.), and skips unavailable entities.

---

## 6. Capability Helpers

- `_isEntityAvailable(id)` — `state` is not `unavailable`/`unknown`/null.
- `_getControlCapabilities(controlled)` — union of `supported_color_modes` across the controlled lights; returns `{rgb, color_temp, brightness, anyLight}`. Drives the disabled/dimmed state of the wheel and sliders.
- `_getServiceTargets(controlled, capability)` — filters for service calls.

---

## 7. Color Wheel

`drawColorWheel()` (mini, 256×256) and `_drawLargeColorWheel()` (overlay, 512×512) render an HSV-ish wheel pixel-by-pixel using `lightness = 0.45 + (1 - sat) * 0.35`. Both are cached by size key on the canvas; the mini wheel auto-redraws via `ResizeObserver`.

**Hit testing:** `_getColorWheelColorAtEvent(e)` and `_getLargeWheelColorAtEvent(e)` use `getImageData(1×1)` with bounds clamped to `[0, canvas.width-1]` × `[0, canvas.height-1]` (Firefox throws `IndexSizeError` at the right/bottom edge otherwise).

**Long-press → large wheel:** A long-press on the mini wheel opens the overlay (`_openLargeColorWheel`). The synthetic click that fires when the user releases the long-press is suppressed via `_largeColorWheelSuppressClick`, which is cleared on the next document `pointerup` (in the next frame, so the synthetic click sees the flag).

---

## 8. Glow / Walls

`_updateAllGlows()` iterates lights and applies a `light-glow` div with shape, length, color, and optional wall-shadow mask. Wall masks are cached per `(entityId, wallConfigVersion, glow shape/size)`. `_normalizeGlowWalls()` accepts both line segments (`[x1, y1, x2, y2]` / `{x1,y1,x2,y2}`) and boxes (`{x, y, width, height}`).

---

## 9. Key Rendering Flow

```
setConfig(config)
  └─ if hass already set: _renderAll()

set hass(hass)
  ├─ first time: _renderAll()
  └─ otherwise + relevant change: updateLights()

_renderAll()
  ├─ _cancelActiveInteractions()
  ├─ _getControlContext()
  ├─ shadowRoot.innerHTML = template
  ├─ Cache _els.*
  ├─ Populate yamlOutput.textContent
  ├─ ResizeObserver on color wheel
  ├─ _attachEventListeners()
  ├─ _updateControlValues() (initial)
  ├─ updateLights()
  ├─ _refreshEntityIcons()
  ├─ _updateSeparatorVisibility() (rAF)
  └─ _subscribeTemplates() (with generation guard)

updateLights()
  ├─ Per .light: color, on/off, selected, unavailable + badge
  ├─ _getControlContext() + _updateControlValues()
  ├─ _refreshColorPresets()
  ├─ _refreshEntityIcons()
  ├─ _updateCanvasElements()
  ├─ _updateAllGlows()
  └─ _repositionLabels()
```

---

## 10. Class-level constants

- `SpatialLightColorCard.RGB_COLOR_MODES` — `Set` of color modes that mean "user picked an RGB color" (`hs`, `rgb`, `xy`, `rgbw`, `rgbww`).
- `SpatialLightColorCard.COLOR_TOLERANCE = 30` — sRGB Euclidean distance for live-color dedup and active-preset matching.
- `SpatialLightColorCard.TEMP_TOLERANCE = 100` — Kelvin tolerance for temperature dedup and matching.

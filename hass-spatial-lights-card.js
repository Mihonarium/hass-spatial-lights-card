class SpatialLightColorCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    /** Core state */
    this._config = {};
    this._hass = null;

    /** Selection & interactions */
    this._selectedLights = new Set();
    this._dragState = null;             // { entity, startX, startY, initialLeft, initialTop, rect, moved }
    this._selectionBox = null;          // HTMLElement for rubberband selection
    this._selectionStart = null;        // { x, y } in canvas coords
    this._selectionModeAdditive = false;
    this._selectionBase = null;

    /** UI state */
    this._yamlModalOpen = false;

    /** History (positions undo/redo) */
    this._history = [];
    this._historyIndex = -1;

    /** Pending user inputs (debounced applies) */
    this._pendingBrightness = null;
    this._pendingTemperature = null;
    this._pendingColor = null;

    /** Settings */
    this._gridSize = 25;
    this._snapOnModifier = true;  // if true, requires Alt key to snap
    this._lockPositions = true;
    this._iconRefreshHandle = null;
    this._iconRehydrateHandle = null;

    /** Animation frame / batching */
    this._raf = null;
    this._colorWheelActive = false;
    this._colorWheelObserver = null;
    this._colorWheelFrame = null;
    this._colorWheelLastSize = null;
    this._colorWheelCancel = null;
    this._colorWheelGesture = null;    // { pointerId, isTouch, startScroll: {x,y}, scrolled, pendingColor }

    /** Large color wheel (long-press) */
    this._largeColorWheelOpen = false;
    this._colorWheelLongPressTimer = null;
    this._colorWheelLongPressStart = null;
    this._colorWheelLongPressed = false;
    this._largeWheelGesture = null;

    /** Cached DOM refs (stable after first render) */
    this._els = {
      canvas: null,
      controlsFloating: null,
      controlsBelow: null,
      brightnessSlider: null,
      brightnessValue: null,
      temperatureSlider: null,
      temperatureValue: null,
      colorWheel: null,
      yamlModal: null,
      yamlOutput: null,
      colorWheelOverlay: null,
      colorWheelLarge: null,
      colorWheelMagnifier: null,
      colorWheelMagnifierCanvas: null,
      colorWheelPreviewSwatch: null,
    };

    /** Global bindings */
    this._boundKeyDown = null;
    this._boundIconsetAdded = null;
    this._boundMoreInfo = null;

    /** Touch affordances */
    this._longPressTimer = null;
    this._longPressTriggered = false;
    this._pendingTap = null;
    this._lastTap = null;

    /** Overlay coordination */
    this._moreInfoOpen = false;
  }

  /** Home Assistant integration */
  setConfig(config) {
    if (!config.entities || !Array.isArray(config.entities)) {
      throw new Error('You must specify entities as an array');
    }

    const normalizedPositions = {};
    if (config.positions && typeof config.positions === 'object') {
      Object.entries(config.positions).forEach(([entity, pos]) => {
        if (!pos || typeof pos !== 'object') return;
        const x = typeof pos.x === 'number' ? pos.x : parseFloat(pos.x);
        const y = typeof pos.y === 'number' ? pos.y : parseFloat(pos.y);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          normalizedPositions[entity] = { x, y };
        }
      });
    }

    let tempMin = null;
    let tempMax = null;
    if (Array.isArray(config.temperature_range) && config.temperature_range.length === 2) {
      const [minVal, maxVal] = config.temperature_range;
      tempMin = typeof minVal === 'number' ? minVal : parseFloat(minVal);
      tempMax = typeof maxVal === 'number' ? maxVal : parseFloat(maxVal);
    } else if (config.temperature_range && typeof config.temperature_range === 'object') {
      const { min, max } = config.temperature_range;
      tempMin = typeof min === 'number' ? min : parseFloat(min);
      tempMax = typeof max === 'number' ? max : parseFloat(max);
    }
    if (config.temperature_min != null && !Number.isNaN(parseFloat(config.temperature_min))) {
      tempMin = parseFloat(config.temperature_min);
    }
    if (config.temperature_max != null && !Number.isNaN(parseFloat(config.temperature_max))) {
      tempMax = parseFloat(config.temperature_max);
    }

    const backgroundImage = this._normalizeBackgroundImage(config.background_image);

    // Normalize light_size (can be number for pixels)
    const lightSize = config.light_size != null ? parseInt(config.light_size, 10) : 56;
    const normalizedLightSize = Number.isFinite(lightSize) && lightSize > 0 ? lightSize : 56;

    // Normalize size_overrides (per-entity sizes)
    const sizeOverrides = {};
    if (config.size_overrides && typeof config.size_overrides === 'object') {
      Object.entries(config.size_overrides).forEach(([entity, size]) => {
        const parsed = parseInt(size, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          sizeOverrides[entity] = parsed;
        }
      });
    }

    // Normalize icon_only_overrides (per-entity icon-only mode)
    const iconOnlyOverrides = {};
    if (config.icon_only_overrides && typeof config.icon_only_overrides === 'object') {
      Object.entries(config.icon_only_overrides).forEach(([entity, val]) => {
        iconOnlyOverrides[entity] = Boolean(val);
      });
    }

    this._config = {
      entities: config.entities,
      positions: normalizedPositions,
      title: config.title || '',
      canvas_height: config.canvas_height || 450,
      grid_size: config.grid_size || 25,
      label_mode: config.label_mode || 'smart',
      label_overrides: config.label_overrides || {},
      always_show_controls: config.always_show_controls || false,
      default_entity: config.default_entity || null,
      controls_below: config.controls_below !== false,
      show_entity_icons: config.show_entity_icons !== false,
      switch_single_tap: config.switch_single_tap || false,
      icon_style: config.icon_style || 'mdi', // 'mdi' or 'emoji' (emoji kept as fallback only)
      temperature_min: Number.isFinite(tempMin) ? tempMin : null,
      temperature_max: Number.isFinite(tempMax) ? tempMax : null,
      background_image: backgroundImage,

      // Light size customization
      light_size: normalizedLightSize,
      size_overrides: sizeOverrides,

      // Minimal UI mode (hides circles completely except when selected)
      minimal_ui: config.minimal_ui || false,

      // Icon-only mode (shows just icons without filled circles)
      // Automatically enabled when minimal_ui is true
      icon_only_mode: config.minimal_ui || config.icon_only_mode || false,
      icon_only_overrides: iconOnlyOverrides,

      // Icon rotation (degrees, 0-360) and mirroring (horizontal/vertical/both/none)
      icon_rotation: Number.isFinite(Number(config.icon_rotation)) ? Number(config.icon_rotation) : 0,
      icon_rotation_overrides: this._normalizeNumberOverrides(config.icon_rotation_overrides),
      icon_mirror: ['horizontal', 'vertical', 'both'].includes(config.icon_mirror) ? config.icon_mirror : 'none',
      icon_mirror_overrides: this._normalizeMirrorOverrides(config.icon_mirror_overrides),

      // Color customization
      switch_on_color: config.switch_on_color || '#ffa500',
      switch_off_color: config.switch_off_color || '#3a3a3a',
      scene_color: config.scene_color || '#6366f1',
      binary_sensor_on_color: config.binary_sensor_on_color || '#4caf50',
      binary_sensor_off_color: config.binary_sensor_off_color || '#2a2a2a',
      color_overrides: config.color_overrides || {},

      // Color presets (array of hex color strings shown as quick-select circles)
      color_presets: Array.isArray(config.color_presets)
        ? config.color_presets.filter(c => typeof c === 'string' && c.trim()).map(c => c.trim())
        : [],
      show_live_colors: config.show_live_colors === true,
    };

    this._gridSize = this._config.grid_size;

    // Editor-driven position editing mode
    this._editPositionsMode = !!config._edit_positions;
    this._editorId = config._editor_id || null;

    this._initializePositions();

    // Re-render if hass is already available (config changed after first render)
    if (this._hass) {
      this._renderAll();
    }
  }

  _normalizeNumberOverrides(obj) {
    const result = {};
    if (obj && typeof obj === 'object') {
      Object.entries(obj).forEach(([entity, val]) => {
        const num = Number(val);
        if (Number.isFinite(num)) result[entity] = num;
      });
    }
    return result;
  }

  _normalizeMirrorOverrides(obj) {
    const result = {};
    if (obj && typeof obj === 'object') {
      Object.entries(obj).forEach(([entity, val]) => {
        if (['horizontal', 'vertical', 'both', 'none'].includes(val)) {
          result[entity] = val;
        }
      });
    }
    return result;
  }

  _normalizeBackgroundImage(value) {
    if (!value) return null;
    if (typeof value === 'string') {
      const url = value.trim();
      return url ? { url } : null;
    }
    if (typeof value === 'object') {
      const url = typeof value.url === 'string' ? value.url.trim() : '';
      const size = typeof value.size === 'string' ? value.size.trim() : '';
      const position = typeof value.position === 'string' ? value.position.trim() : '';
      const repeat = typeof value.repeat === 'string' ? value.repeat.trim() : '';
      const blend = typeof value.blend_mode === 'string' ? value.blend_mode.trim() : '';
      const opacity = typeof value.opacity === 'number' ? value.opacity : (typeof value.opacity === 'string' ? parseFloat(value.opacity) : NaN);
      if (!url && !size && !position && !repeat && !blend && isNaN(opacity)) return null;
      const normalized = {};
      if (url) normalized.url = url;
      if (size) normalized.size = size;
      if (position) normalized.position = position;
      if (repeat) normalized.repeat = repeat;
      if (blend) normalized.blend_mode = blend;
      if (!isNaN(opacity)) normalized.opacity = Math.max(0, Math.min(1, opacity));
      return normalized;
    }
    return null;
  }

  _canvasBackgroundStyle() {
    const bg = this._config.background_image;
    if (!bg) return '';
    const vars = [];
    if (bg.url) {
      const escaped = String(bg.url).replace(/"/g, '%22').replace(/'/g, "\\'");
      vars.push(`--canvas-background-image:url('${escaped}')`);
    }
    if (bg.size) vars.push(`--canvas-background-size:${bg.size}`);
    if (bg.position) vars.push(`--canvas-background-position:${bg.position}`);
    if (bg.repeat) vars.push(`--canvas-background-repeat:${bg.repeat}`);
    if (bg.blend_mode) vars.push(`--canvas-background-blend-mode:${bg.blend_mode}`);
    if (bg.opacity !== undefined && bg.opacity !== null) vars.push(`--canvas-background-opacity:${bg.opacity}`);
    return vars.join('; ');
  }

  set hass(hass) {
    const firstTime = !this._hass;
    this._hass = hass;
    if (firstTime) {
      this._renderAll();
    } else {
      this.updateLights();
    }
  }

  /** ---------- Label system ---------- */
  _generateLabel(entity_id) {
    if (this._config.label_overrides[entity_id]) {
      return this._config.label_overrides[entity_id];
    }
    const st = this._hass?.states[entity_id];
    if (!st) return '?';

    const name = st.attributes.friendly_name || entity_id;
    const allNames = this._config.entities.map(e => this._hass?.states[e]?.attributes.friendly_name || e);

    // 1) trailing numbers
    const m = name.match(/(\d+)$/);
    if (m) {
      const base = name.substring(0, name.length - m[0].length).trim();
      const n = m[0];
      const similar = allNames.filter(nm => nm.startsWith(base)).length;
      if (similar > 1) {
        return this._getInitials(base) + n;
      }
    }
    // 2) directional
    const words = name.split(/\s+/);
    const dirs = ['left', 'right', 'center', 'front', 'back', 'top', 'bottom', 'north', 'south', 'east', 'west'];
    const dirWord = words.find(w => dirs.includes(w.toLowerCase()));
    if (dirWord) {
      const baseWords = words.filter(w => w !== dirWord);
      const initials = baseWords.slice(0, 2).map(w => w[0]).join('');
      return (initials + dirWord[0]).toUpperCase();
    }
    return this._getInitials(name);
  }

  _getInitials(text) {
    const stop = ['the', 'a', 'an', 'light', 'lamp', 'bulb'];
    const ws = text.split(/\s+/).filter(w => w && !stop.includes(w.toLowerCase()));
    if (ws.length === 0) return text.substring(0, 2).toUpperCase();
    if (ws.length === 1) return ws[0].substring(0, 2).toUpperCase();
    return ws.slice(0, 3).map(w => w[0]).join('').toUpperCase();
  }

  /** ---------- Icon system (SVG via HA components) ---------- */
  _getEntityIconData(entity_id) {
    const st = this._hass?.states[entity_id];
    if (!st) {
      if (entity_id.startsWith('scene.')) return { type: 'mdi', value: 'mdi:palette' };
      return { type: 'mdi', value: 'mdi:lightbulb' };
    }
    const icon = st.attributes.icon || (entity_id.startsWith('scene.') ? 'mdi:palette' : 'mdi:lightbulb');
    if (this._config.icon_style === 'emoji') {
      // Fallback only; discouraged in this upgrade
      return { type: 'emoji', value: '💡' };
    }
    if (icon.startsWith('mdi:')) return { type: 'mdi', value: icon };
    // HA sometimes sets arbitrary icon strings; attempt to feed into ha-icon anyway
    return { type: 'mdi', value: icon };
  }

  _getIconTransform(entity_id) {
    const rotation = this._config.icon_rotation_overrides[entity_id] !== undefined
      ? this._config.icon_rotation_overrides[entity_id]
      : this._config.icon_rotation;
    const mirror = this._config.icon_mirror_overrides[entity_id] !== undefined
      ? this._config.icon_mirror_overrides[entity_id]
      : this._config.icon_mirror;
    const parts = [];
    if (rotation) parts.push(`rotate(${rotation}deg)`);
    if (mirror === 'horizontal') parts.push('scaleX(-1)');
    else if (mirror === 'vertical') parts.push('scaleY(-1)');
    else if (mirror === 'both') parts.push('scale(-1,-1)');
    return parts.length ? parts.join(' ') : '';
  }

  _renderIcon(iconData) {
    if (iconData.type === 'mdi') {
      return `<ha-icon class="light-icon light-icon-mdi" data-icon="${iconData.value}" icon="${iconData.value}"></ha-icon>`;
    }
    if (iconData.type === 'emoji') {
      return `<div class="light-icon light-icon-emoji">${iconData.value}</div>`;
    }
    return `<ha-icon class="light-icon light-icon-mdi" data-icon="mdi:lightbulb" icon="mdi:lightbulb"></ha-icon>`;
  }

  _scheduleIconRefresh(attempt, delay) {
    if (this._iconRefreshHandle) {
      clearTimeout(this._iconRefreshHandle);
    }
    this._iconRefreshHandle = setTimeout(() => {
      this._iconRefreshHandle = null;
      this._refreshEntityIcons(attempt);
    }, delay);
  }

  _refreshEntityIcons(attempt = 0) {
    if (!this.shadowRoot) return;
    const icons = this.shadowRoot.querySelectorAll('ha-icon[data-icon]');
    if (!icons.length) return;

    const applyIcons = () => {
      icons.forEach(iconEl => {
        const iconName = iconEl.getAttribute('data-icon');
        if (!iconName) return;
        if (iconEl.icon !== iconName) {
          iconEl.icon = iconName;
        }
        if (iconEl.getAttribute('icon') !== iconName) {
          iconEl.setAttribute('icon', iconName);
        }
        if (this._hass && iconEl.hass !== this._hass) {
          iconEl.hass = this._hass;
        }
      });
    };

    const ensureDefined = () => {
      applyIcons();
      const unresolved = Array.from(icons).some(iconEl => {
        if (!iconEl.shadowRoot) return true;
        return !iconEl.shadowRoot.querySelector('ha-svg-icon, svg');
      });
      if (unresolved && attempt < 8) {
        this._scheduleIconRefresh(attempt + 1, 250 * (attempt + 1));
        if (!this._iconRehydrateHandle) {
          this._iconRehydrateHandle = setTimeout(() => {
            this._iconRehydrateHandle = null;
            this._forceIconRerender();
          }, 120);
        }
      } else if (!unresolved && this._iconRehydrateHandle) {
        clearTimeout(this._iconRehydrateHandle);
        this._iconRehydrateHandle = null;
      }
    };

    if (typeof customElements === 'undefined') {
      ensureDefined();
      return;
    }

    if (customElements.get('ha-icon')) {
      ensureDefined();
    } else if (attempt < 8) {
      customElements.whenDefined('ha-icon').then(() => this._refreshEntityIcons(attempt + 1));
    }
  }

  _forceIconRerender() {
    if (!this.shadowRoot) return;
    const lights = this.shadowRoot.querySelectorAll('.light');
    if (!lights.length) return;

    lights.forEach(light => {
      const existing = light.querySelector('ha-icon[data-icon]');
      if (!existing) return;
      const iconName = existing.getAttribute('data-icon');
      if (!iconName) return;
      const replacement = document.createElement('ha-icon');
      replacement.className = existing.className;
      replacement.setAttribute('data-icon', iconName);
      replacement.setAttribute('icon', iconName);
      if (this._hass) {
        replacement.hass = this._hass;
      }
      light.replaceChild(replacement, existing);
    });

    const raf = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb) => setTimeout(cb, 16);
    raf(() => this._refreshEntityIcons());
  }

  _toggleEntity(entity) {
    if (!this._hass) return;
    const stateObj = this._hass.states?.[entity];
    if (!stateObj) return;
    const [domain] = entity.split('.');
    
    if (domain === 'binary_sensor') return;

    if (domain === 'scene') {
      this._hass.callService('scene', 'turn_on', { entity_id: entity });
      return;
    }

    if (domain !== 'light' && domain !== 'switch' && domain !== 'input_boolean') return;
    const service = stateObj.state === 'on' ? 'turn_off' : 'turn_on';
    this._hass.callService(domain, service, { entity_id: entity });
  }

  _openMoreInfo(entity) {
    this._moreInfoOpen = true;
    this._syncOverlayState();
    this.dispatchEvent(new CustomEvent('hass-more-info', {
      detail: { entityId: entity },
      bubbles: true,
      composed: true,
    }));
  }

  /** ---------- Auto-layout / rearrange ---------- */
  _initializePositions() {
    const unpos = this._config.entities.filter(e => !this._config.positions[e]);
    if (unpos.length === 0) return;

    const cols = Math.ceil(Math.sqrt(unpos.length * 1.5));
    const rows = Math.ceil(unpos.length / cols);
    const spacing = 100 / (cols + 1);

    unpos.forEach((entity, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      this._config.positions[entity] = {
        x: spacing * (col + 1),
        y: (100 / (rows + 1)) * (row + 1),
      };
    });
  }

  _rearrangeAllLights() {
    // Cancel any active interactions first
    this._cancelActiveInteractions();

    const entities = this._config.entities;
    const cols = Math.ceil(Math.sqrt(entities.length * 1.5));
    const rows = Math.ceil(entities.length / cols);
    const spacing = 100 / (cols + 1);

    const previousPositions = this._clonePositions();
    const newPositions = {};
    entities.forEach((entity, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const pos = {
        x: spacing * (col + 1),
        y: (100 / (rows + 1)) * (row + 1),
      };
      newPositions[entity] = pos;
    });

    this._config.positions = newPositions;
    this._saveHistory(previousPositions);
    this._saveHistory(newPositions);
    this._smoothApplyPositions();
    this.updateLights();
  }

  _smoothApplyPositions() {
    // Smoothly transition existing DOM nodes instead of full re-render
    const lights = this.shadowRoot.querySelectorAll('.light');
    lights.forEach(light => {
      const entity = light.dataset.entity;
      const pos = this._config.positions[entity];
      if (pos) {
        light.style.transition = 'left 200ms ease, top 200ms ease';
        light.style.left = `${pos.x}%`;
        light.style.top = `${pos.y}%`;
        // Remove transition after complete to avoid future lag
        setTimeout(() => {
          if (light) light.style.transition = '';
        }, 250);
      }
    });
    // Controls may rely on selection state; keep as-is.
  }

  /** ---------- History ---------- */
  _saveHistory(snapshot = null) {
    const snapshotPositions = this._clonePositions(snapshot || this._config.positions);
    const last = this._history[this._historyIndex];
    if (last && JSON.stringify(last) === JSON.stringify(snapshotPositions)) return;

    this._history = this._history.slice(0, this._historyIndex + 1);
    this._history.push(snapshotPositions);
    if (this._history.length > 50) {
      this._history.shift();
      this._historyIndex = this._history.length - 1;
    } else {
      this._historyIndex++;
    }
  }
  _undo() {
    if (this._historyIndex > 0) {
      this._historyIndex--;
      this._config.positions = this._clonePositions(this._history[this._historyIndex]);
      this._smoothApplyPositions();
    }
  }
  _redo() {
    if (this._historyIndex < this._history.length - 1) {
      this._historyIndex++;
      this._config.positions = this._clonePositions(this._history[this._historyIndex]);
      this._smoothApplyPositions();
    }
  }

  /** ---------- Grid snap ---------- */
  _shouldSnap(event) {
    return event?.altKey || !this._snapOnModifier;
  }
  _snapToGrid(x, y, event) {
    if (!this._shouldSnap(event)) return { x, y };
    const canvas = this._els.canvas;
    if (!canvas) return { x, y };
    const rect = canvas.getBoundingClientRect();
    const px = (x / 100) * rect.width;
    const py = (y / 100) * rect.height;
    const sx = Math.round(px / this._gridSize) * this._gridSize;
    const sy = Math.round(py / this._gridSize) * this._gridSize;
    return { x: (sx / rect.width) * 100, y: (sy / rect.height) * 100 };
  }

  /** ---------- Aggregated state of selected lights ---------- */
  _getControlledEntities() {
    if (this._selectedLights.size > 0) {
      return [...this._selectedLights];
    }
    if (this._config.default_entity) {
      return [this._config.default_entity];
    }
    return [];
  }

  _clampTemperature(value, range) {
    if (!range) return value;
    return Math.max(range.min, Math.min(range.max, value));
  }

  _clonePositions(source = this._config.positions) {
    return JSON.parse(JSON.stringify(source || {}));
  }

  _resolveTemperatureRange(controlled) {
    const explicitMin = Number.isFinite(this._config.temperature_min) ? this._config.temperature_min : null;
    const explicitMax = Number.isFinite(this._config.temperature_max) ? this._config.temperature_max : null;

    let minK = explicitMin ?? Infinity;
    let maxK = explicitMax ?? -Infinity;

    const pool = (controlled && controlled.length > 0) ? controlled : this._config.entities;

    pool.forEach(entity_id => {
      const st = this._hass?.states?.[entity_id];
      if (!st) return;
      const attrs = st.attributes || {};

      const maxMireds = attrs.max_mireds != null ? Number(attrs.max_mireds) : NaN;
      const minMireds = attrs.min_mireds != null ? Number(attrs.min_mireds) : NaN;
      if (Number.isFinite(maxMireds) && Number.isFinite(minMireds)) {
        const warm = Math.round(1000000 / maxMireds);
        const cool = Math.round(1000000 / minMireds);
        minK = Math.min(minK, warm);
        maxK = Math.max(maxK, cool);
        return;
      }

      const colorTempKelvin = attrs.color_temp_kelvin != null ? Number(attrs.color_temp_kelvin) : NaN;
      if (Number.isFinite(colorTempKelvin)) {
        const current = Math.round(colorTempKelvin);
        minK = Math.min(minK, current);
        maxK = Math.max(maxK, current);
        return;
      }

      const colorTempMired = attrs.color_temp != null ? Number(attrs.color_temp) : NaN;
      if (Number.isFinite(colorTempMired)) {
        const current = Math.round(1000000 / colorTempMired);
        minK = Math.min(minK, current);
        maxK = Math.max(maxK, current);
      }
    });

    if (!Number.isFinite(minK)) minK = explicitMin ?? 2000;
    if (!Number.isFinite(maxK)) maxK = explicitMax ?? 6500;

    if (explicitMin != null) minK = explicitMin;
    if (explicitMax != null) maxK = explicitMax;

    minK = Math.max(1000, Math.round(minK));
    maxK = Math.min(10000, Math.round(maxK));

    if (minK >= maxK) {
      const base = Math.max(1000, Math.round((minK + maxK) / 2) || 3000);
      minK = Math.max(1000, base - 100);
      maxK = Math.max(minK + 100, base + 100);
    }

    return { min: minK, max: maxK };
  }

  _getControlContext() {
    const controlled = this._getControlledEntities();

    let bTot = 0, bCnt = 0;
    let tTot = 0, tCnt = 0;
    let lastRGB = null;

    controlled.forEach(id => {
      const st = this._hass?.states?.[id];
      if (!st || st.state !== 'on') return;
      if (st.attributes.brightness != null) {
        bTot += st.attributes.brightness; bCnt++;
      }
      if (st.attributes.color_temp != null) {
        const kelvin = Math.round(1000000 / st.attributes.color_temp);
        tTot += kelvin; tCnt++;
      }
      if (Array.isArray(st.attributes.rgb_color)) {
        lastRGB = st.attributes.rgb_color;
      }
    });

    const range = this._resolveTemperatureRange(controlled);

    const avgBrightness = bCnt ? Math.round(bTot / bCnt) : 128;
    const avgTemperatureRaw = tCnt ? Math.round(tTot / tCnt) : Math.round((range.min + range.max) / 2);
    const avgTemperature = this._clampTemperature(avgTemperatureRaw, range);

    return {
      controlled,
      avgState: {
        brightness: avgBrightness,
        temperature: avgTemperature,
        color: lastRGB,
      },
      tempRange: range,
    };
  }

  /** ---------- Rendering ---------- */
  _renderAll() {
    const controlContext = this._getControlContext();
    const avgState = controlContext.avgState;
    const showControls = this._config.always_show_controls || this._selectedLights.size > 0 || this._config.default_entity;
    const controlsPosition = this._config.controls_below ? 'below' : 'floating';
    const showHeader = !!this._config.title;

    this.shadowRoot.innerHTML = `
      <style>
        ${this._styles()}
      </style>
      <ha-card>
        ${showHeader ? this._renderHeader() : ''}
        <div class="canvas-wrapper">
          <div class="canvas" id="canvas" role="application" aria-label="Spatial light control area" style="${this._canvasBackgroundStyle()}">
            <div class="grid"></div>
            ${this._config.entities.length === 0 ? this._renderEmptyState() : this._renderLightsHTML()}
            ${controlsPosition === 'floating' ? this._renderControlsFloating(showControls, controlContext) : ''}
          </div>
          ${controlsPosition === 'below' ? this._renderControlsBelow(controlContext) : ''}
        </div>
        ${this._renderYamlModal()}
      </ha-card>
      ${this._renderLargeColorWheel()}
    `;

    // Cache refs once
    this._els.canvas = this.shadowRoot.getElementById('canvas');
    this._els.controlsFloating = this.shadowRoot.getElementById('controlsFloating');
    this._els.controlsBelow = this.shadowRoot.getElementById('controlsBelow');
    this._els.brightnessSlider = this.shadowRoot.getElementById('brightnessSlider');
    this._els.brightnessValue = this.shadowRoot.getElementById('brightnessValue');
    this._els.temperatureSlider = this.shadowRoot.getElementById('temperatureSlider');
    this._els.temperatureValue = this.shadowRoot.getElementById('temperatureValue');
    this._els.colorWheel = this.shadowRoot.getElementById('colorWheelMini');
    this._els.yamlModal = this.shadowRoot.getElementById('yamlModal');
    this._els.yamlOutput = this.shadowRoot.getElementById('yamlOutput');
    this._els.colorWheelOverlay = this.shadowRoot.getElementById('colorWheelOverlay');
    this._els.colorWheelLarge = this.shadowRoot.getElementById('colorWheelLarge');
    this._els.colorWheelMagnifier = this.shadowRoot.getElementById('colorWheelMagnifier');
    this._els.colorWheelMagnifierCanvas = this.shadowRoot.getElementById('colorWheelMagnifierCanvas');
    this._els.colorWheelPreviewSwatch = this.shadowRoot.getElementById('colorWheelPreviewSwatch');

    if (this._colorWheelObserver) {
      this._colorWheelObserver.disconnect();
      this._colorWheelObserver = null;
    }
    if (this._els.colorWheel && typeof window !== 'undefined' && 'ResizeObserver' in window) {
      this._colorWheelObserver = new ResizeObserver(() => {
        this._requestColorWheelDraw(true);
      });
      this._colorWheelObserver.observe(this._els.colorWheel);
    }

    this._attachEventListeners();
    if ((showControls || this._config.always_show_controls) && this._els.colorWheel) {
      const raf = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (cb) => setTimeout(cb, 16);
      raf(() => {
        this._requestColorWheelDraw(true);
      });
      this._updateControlValues(controlContext);
    }
    this._syncOverlayState();
    this.updateLights();
    this._refreshEntityIcons();
  }

  _styles() {
    return `
      * { box-sizing: border-box; margin: 0; padding: 0; }
      :host {
        --surface-primary: #0a0a0a;
        --surface-secondary: #141414;
        --surface-tertiary: #1a1a1a;
        --surface-elevated: #1f1f1f;

        --text-primary: #ffffff;
        --text-secondary: rgba(255,255,255,0.7);
        --text-tertiary: rgba(255,255,255,0.45);

        --border-subtle: rgba(255,255,255,0.06);
        --border-medium: rgba(255,255,255,0.12);

        --accent-primary: #6366f1;

        --grid-dots: rgba(255,255,255,0.035);

        --shadow-sm: 0 1px 2px rgba(0,0,0,0.35);
        --shadow-md: 0 4px 8px rgba(0,0,0,0.45);

        --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif;

        --radius-sm: 6px; --radius-md: 8px; --radius-lg: 12px; --radius-full: 9999px;

        --transition-fast: 120ms cubic-bezier(0.4,0,0.2,1);
        --transition-base: 200ms cubic-bezier(0.4,0,0.2,1);
      }
      @media (prefers-reduced-motion: reduce) {
        :host { --transition-fast: 0ms; --transition-base: 0ms; }
        * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
      }
      ha-card {
        background: var(--surface-primary);
        overflow: hidden;
        font-family: var(--font-sans);
        position: relative;
        z-index: 0;
      }

      .header {
        padding: 16px 20px; display: flex; justify-content: space-between; align-items: center;
        border-bottom: 1px solid var(--border-subtle); background: var(--surface-secondary);
      }
      .title { font-size: 14px; font-weight: 600; color: var(--text-secondary); letter-spacing: -0.01em; }

      .canvas-wrapper { position: relative; }
      .canvas {
        position: relative; width: 100%; height: ${this._config.canvas_height}px; background: var(--surface-primary);
        overflow: hidden; user-select: none; touch-action: none;
      }
      .canvas::before {
        content: ''; position: absolute; inset: 0;
        background-image: var(--canvas-background-image, none);
        background-size: var(--canvas-background-size, cover);
        background-position: var(--canvas-background-position, center);
        background-repeat: var(--canvas-background-repeat, no-repeat);
        mix-blend-mode: var(--canvas-background-blend-mode, normal);
        opacity: var(--canvas-background-opacity, 1);
        pointer-events: none; z-index: 0;
      }
      .grid {
        position: absolute; inset: 0;
        background-image: radial-gradient(circle, var(--grid-dots) 1px, transparent 1px);
        background-size: ${this._gridSize}px ${this._gridSize}px; pointer-events: none;
      }

      .light {
        --light-size: ${this._config.light_size}px;
        --icon-scale: 1;
        position: absolute; width: var(--light-size); height: var(--light-size); border-radius: var(--radius-full);
        transform: translate(-50%,-50%); cursor: ${(this._lockPositions && !this._editPositionsMode) ? 'pointer' : 'grab'};
        display:flex; align-items:center; justify-content:center; flex-direction:column;
        will-change: transform, left, top, background; z-index: 1;
        transition: opacity 200ms ease, filter 200ms ease;
      }
      .light::before { content:''; position:absolute; inset:0; border-radius:inherit; background:inherit; box-shadow: var(--shadow-sm); transition: box-shadow 200ms ease, border-color 200ms ease, border-width 200ms ease, background-color 200ms ease, inset 200ms ease; }
      .light.on::after {
        content:''; position:absolute; inset:-6px; border-radius:inherit; background:inherit; filter: blur(10px);
        opacity: 0.22; z-index: -1;
      }
      /* Remove forced gradient, allow JS to override background if needed */
      .light.off { opacity: 0.55; }
      .light.off:not([style*="background"]) { background: linear-gradient(135deg,#3a3a3a 0%, #2a2a2a 100%); }
      .light.off::after { display:none; }

      /* Icon-only mode styles */
      .light.icon-only {
        background: transparent !important;
      }
      .light.icon-only::before {
        background: transparent;
        box-shadow: none;
        border: 2px solid var(--light-color, rgba(255,255,255,0.3));
      }
      .light.icon-only.on::before {
        border-color: var(--light-color, #ffa500);
        box-shadow: 0 0 8px var(--light-color, #ffa500);
      }
      .light.icon-only.off::before {
        border-color: rgba(255,255,255,0.25);
        box-shadow: none;
      }
      .light.icon-only::after {
        display: none;
      }
      .light.icon-only .light-icon-mdi {
        color: var(--light-color, rgba(255,255,255,0.7));
        filter: drop-shadow(0 1px 3px rgba(0,0,0,0.8));
      }
      .light.icon-only.off .light-icon-mdi {
        color: rgba(255,255,255,0.6);
      }
      .light.icon-only.off { opacity: 0.8; }
      /* Selection indicator for icon-only mode */
      .light.icon-only.selected::before {
        border-color: var(--accent-primary);
        border-width: 2.5px;
        background: rgba(99,102,241,0.1);
        box-shadow: 0 0 0 1px rgba(99,102,241,0.3), 0 0 12px rgba(99,102,241,0.55);
      }
      .light.icon-only.selected.on::before {
        border-color: var(--accent-primary);
        background: rgba(99,102,241,0.08);
        box-shadow: 0 0 0 1px rgba(99,102,241,0.3), 0 0 12px rgba(99,102,241,0.55), 0 0 8px var(--light-color, #ffa500);
      }

      /* Minimal UI mode - hides circles completely, shows only icons */
      .light.minimal-ui {
        background: transparent !important;
      }
      .light.minimal-ui::before {
        background: transparent;
        box-shadow: none;
        border: none;
      }
      .light.minimal-ui::after {
        display: none;
      }
      .light.minimal-ui .light-icon-mdi {
        color: var(--light-color, rgba(255,255,255,0.85));
        filter: drop-shadow(0 1px 4px rgba(0,0,0,0.9)) drop-shadow(0 0 2px rgba(0,0,0,0.5));
      }
      .light.minimal-ui.on .light-icon-mdi {
        filter: drop-shadow(0 0 6px var(--light-color, #ffa500)) drop-shadow(0 1px 3px rgba(0,0,0,0.8));
      }
      .light.minimal-ui.off .light-icon-mdi {
        color: rgba(255,255,255,0.55);
      }
      .light.minimal-ui.off {
        opacity: 1;
      }
      /* Show circle with accent highlight when selected in minimal mode */
      .light.minimal-ui.selected::before {
        border: 2px solid var(--accent-primary);
        background: rgba(99,102,241,0.12);
        box-shadow: 0 0 10px rgba(99,102,241,0.45);
      }
      .light.minimal-ui.selected.on::before {
        border-color: var(--accent-primary);
        background: rgba(99,102,241,0.08);
        box-shadow: 0 0 10px rgba(99,102,241,0.45), 0 0 8px var(--light-color, #ffa500);
      }

      .light-icon-emoji { font-size: calc(32px * var(--icon-scale, 1)); line-height: 1; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.6)); transform: var(--icon-transform, none); }
      .light-icon-mdi { --mdc-icon-size: calc(32px * var(--icon-scale, 1)); color: rgba(255,255,255,0.92); filter: drop-shadow(0 1px 2px rgba(0,0,0,0.6)); transform: var(--icon-transform, none); }

      .light-label {
        position: absolute; top: calc(100% + 8px); left: 50%; transform: translateX(-50%);
        padding: 4px 8px; background: var(--surface-elevated); color: var(--text-primary);
        font-size: 11px; font-weight: 600; border-radius: var(--radius-sm); white-space: nowrap; pointer-events: none;
        opacity: 0; transition: opacity var(--transition-fast); z-index: 5; border: 1px solid var(--border-subtle);
      }
      .light:hover .light-label { opacity: 1; }

      .light.selected { z-index: 3; }
      .light.selected::before {
        box-shadow: 0 0 0 2.5px rgba(99,102,241,0.9), 0 0 0 5px rgba(99,102,241,0.25), 0 0 15px rgba(99,102,241,0.5);
      }
      /* Selected off lights should be more visible than normal off lights */
      .light.selected.off { opacity: 0.82; }
      .light.selected.off.icon-only { opacity: 0.92; }
      .light.selected.off.minimal-ui { opacity: 1; }
      /* Always show label for selected lights */
      .light.selected .light-label { opacity: 1; }
      /* Dim unselected lights when a selection is active to increase contrast */
      .canvas.has-selection .light:not(.selected) { filter: brightness(0.55) saturate(0.6); }
      .canvas.has-selection .light.off:not(.selected) { filter: brightness(0.45) saturate(0.5); }

      .light.preset-highlight::before {
        box-shadow: 0 0 0 2.5px rgba(255,255,255,0.7), 0 0 16px rgba(255,255,255,0.35) !important;
      }
      .light.preset-highlight { z-index: 4; filter: brightness(1.2) !important; }

      .light.dragging { cursor: grabbing; z-index: 6; transform: translate(-50%,-50%) scale(1.04); }

      .selection-box {
        position: absolute; border: 1.5px solid rgba(99,102,241,0.5); background: rgba(99,102,241,0.08);
        border-radius: 8px; pointer-events: none; backdrop-filter: blur(2px);
      }

      .controls-floating {
        position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%);
        background: rgba(20,20,20,0.95); backdrop-filter: blur(16px) saturate(160%);
        border: 1px solid var(--border-medium); border-radius: 12px; padding: 16px 20px;
        display: grid; grid-template-columns: auto 1fr; grid-template-rows: auto auto;
        gap: 12px 20px; align-items: start; box-shadow: var(--shadow-md);
        opacity: 0; pointer-events: none; transition: opacity var(--transition-base);
        z-index: 50;
      }
      .controls-floating.visible { opacity: 1; pointer-events: auto; }

      .controls-below {
        padding: 20px; border-top: 1px solid var(--border-subtle); background: var(--surface-secondary);
        display: none;
        grid-template-columns: auto 1fr; grid-template-rows: auto auto;
        gap: 12px 24px; align-items: start; justify-content: center;
      }
      .controls-below.visible { display: grid; }

      .color-wheel-mini {
        width: 128px; height: 128px; border-radius: 9999px; cursor: pointer;
        border: 2px solid var(--border-subtle); box-shadow: var(--shadow-sm); flex-shrink: 0;
        grid-column: 1; grid-row: 1 / 3; align-self: start;
      }

      .presets-area {
        grid-column: 2; grid-row: 2;
        display: flex; flex-wrap: wrap; gap: 2px; align-items: center;
        margin-left: -4px; /* Align visual preset circles with slider left edge */
      }

      .preset-separator {
        width: 1px; height: 20px; background: rgba(255,255,255,0.12);
        margin: 0 3px; flex-shrink: 0; align-self: center;
      }
      .color-preset {
        width: 36px; height: 36px; border-radius: 9999px; cursor: pointer;
        flex-shrink: 0; position: relative; background: transparent !important;
        /* Stable hit area - visual is rendered via ::after */
      }
      .color-preset::after {
        content: ''; position: absolute; inset: 4px; border-radius: 9999px;
        background: var(--preset-color); border: 2px solid rgba(255,255,255,0.15);
        box-shadow: var(--shadow-sm);
        transition: transform var(--transition-fast), border-color var(--transition-fast), box-shadow var(--transition-fast);
      }
      .color-preset:hover::after { transform: scale(1.15); border-color: rgba(255,255,255,0.5); box-shadow: 0 0 8px rgba(255,255,255,0.2); }
      .color-preset:active::after { transform: scale(0.92); }
      .color-preset.active::after { box-shadow: 0 0 0 2px rgba(255,255,255,0.5); }
      .color-preset.active:hover::after { box-shadow: 0 0 0 2px rgba(255,255,255,0.5), 0 0 8px rgba(255,255,255,0.2); }

      .temp-preset {
        width: 36px; height: 36px; border-radius: 9999px; cursor: pointer;
        flex-shrink: 0; position: relative; background: transparent !important;
      }
      .temp-preset::after {
        content: ''; position: absolute; inset: 4px; border-radius: 9999px;
        background: var(--preset-color); border: 2px solid rgba(255,255,255,0.15);
        box-shadow: var(--shadow-sm);
        transition: transform var(--transition-fast), border-color var(--transition-fast), box-shadow var(--transition-fast);
      }
      .temp-preset:hover::after { transform: scale(1.15); border-color: rgba(255,255,255,0.5); box-shadow: 0 0 8px rgba(255,255,255,0.2); }
      .temp-preset:active::after { transform: scale(0.92); }
      .temp-preset.active::after { box-shadow: 0 0 0 2px rgba(255,255,255,0.5); }
      .temp-preset.active:hover::after { box-shadow: 0 0 0 2px rgba(255,255,255,0.5), 0 0 8px rgba(255,255,255,0.2); }
      .temp-preset .temp-label {
        position: absolute; top: calc(100% + 2px); left: 50%; transform: translateX(-50%);
        font-size: 9px; color: var(--text-tertiary); white-space: nowrap; pointer-events: none;
        opacity: 0; transition: opacity var(--transition-fast);
      }
      .temp-preset:hover .temp-label { opacity: 1; }

      .slider-group { display:flex; flex-direction:column; gap:10px; min-width: 240px; grid-column: 2; grid-row: 1; }
      .slider-row { display:flex; align-items:center; gap:8px; width:100%; padding: 2px 0; }

      .slider {
        flex:1; -webkit-appearance:none; appearance:none;
        --slider-height: 24px;
        --slider-thumb-size: 26px;
        --slider-track-radius: 9999px;
        --slider-percent: 50%;
        --slider-ratio: 0.5;
        --slider-fill: var(--accent-primary);
        height: var(--slider-height);
        border-radius: var(--slider-track-radius);
        background:
          linear-gradient(to right, var(--slider-fill) 0%, var(--slider-fill) 100%),
          linear-gradient(to right, var(--surface-tertiary) 0%, var(--surface-tertiary) 100%);
        background-size:
          calc((100% - var(--slider-thumb-size)) * var(--slider-ratio) + (var(--slider-thumb-size) / 2)) 100%,
          100% 100%;
        background-repeat: no-repeat, no-repeat;
        background-position: left center, left center;
        outline:none; position:relative; cursor:pointer;
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.05), inset 0 -1px 0 rgba(0,0,0,0.12), var(--shadow-sm);
      }
      .slider.temperature {
        background:
          linear-gradient(to right,
            rgba(255,255,255,0.18) 0%,
            rgba(255,255,255,0.18) 100%),
          linear-gradient(to right,
            #ff9944 0%,
            #ffd480 30%,
            #ffffff 50%,
            #87ceeb 70%,
            #4d9fff 100%),
          linear-gradient(to right, var(--surface-tertiary) 0%, var(--surface-tertiary) 100%);
        background-size:
          calc((100% - var(--slider-thumb-size)) * var(--slider-ratio) + (var(--slider-thumb-size) / 2)) 100%,
          100% 100%,
          100% 100%;
        background-repeat: no-repeat, no-repeat, no-repeat;
        background-position: left center, left center, left center;
      }
      .slider::-webkit-slider-thumb {
        -webkit-appearance:none; width:var(--slider-thumb-size); height:var(--slider-thumb-size); border-radius:9999px;
        background: var(--text-primary); border:3px solid var(--surface-primary); box-shadow: 0 3px 10px rgba(0,0,0,0.35);
        transition: transform var(--transition-fast), box-shadow var(--transition-fast);
        transform: scale(1.05);
        margin-top: 0;
      }
      .slider::-webkit-slider-thumb:hover { transform: scale(1.05); box-shadow: 0 3px 10px rgba(0,0,0,0.35); }
      .slider::-moz-range-thumb {
        width:var(--slider-thumb-size); height:var(--slider-thumb-size); border-radius:9999px; background: var(--text-primary);
        border:3px solid var(--surface-primary); box-shadow: 0 3px 10px rgba(0,0,0,0.35);
        transition: transform var(--transition-fast), box-shadow var(--transition-fast);
        transform: scale(1.05);
      }
      .slider::-moz-range-thumb:hover { transform: scale(1.05); box-shadow: 0 3px 10px rgba(0,0,0,0.35); }
      .slider::-moz-range-track {
        height: 100%;
        border-radius: var(--slider-track-radius);
        background: var(--slider-track);
        border: none;
      }
      .slider-value { font-size: 13px; color: var(--text-secondary); min-width: 56px; text-align:right; font-weight: 700; letter-spacing: 0.01em; align-self:center; }

      .modal-overlay {
        position: fixed; inset: 0; background: rgba(0,0,0,0.8); backdrop-filter: blur(8px);
        display:none; align-items:center; justify-content:center; z-index:1000; padding:16px;
      }
      .modal-overlay.visible { display:flex; }
      .modal {
        background: var(--surface-secondary); border:1px solid var(--border-medium); border-radius:12px; padding:20px; max-width: 700px; width:100%; max-height: 80vh; overflow:auto; box-shadow: var(--shadow-md);
      }
      .modal-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; }
      .modal-title { font-size:18px; font-weight:600; color: var(--text-primary); letter-spacing: -0.01em; }
      .modal-close {
        width: 32px; height:32px; border:none; background:transparent; color: var(--text-tertiary);
        border-radius:8px; cursor:pointer; font-size:24px; display:flex; align-items:center; justify-content:center;
        transition: background var(--transition-fast), color var(--transition-fast), transform var(--transition-fast);
      }
      .modal-close:hover { background: var(--surface-tertiary); color: var(--text-secondary); }
      .modal-close:active { transform: scale(0.96); }
      .yaml-output {
        background: var(--surface-primary); border:1px solid var(--border-subtle); border-radius: 8px; padding: 12px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
        font-size: 12px; line-height: 1.6; color: var(--text-primary); white-space: pre; overflow-x: auto; user-select: all;
      }
      .modal-hint { margin-top: 8px; font-size:12px; color: var(--text-tertiary); text-align:center; }

      @media (max-width: 768px) {
        .controls-floating {
          display: flex; flex-wrap: wrap; justify-content: center;
          gap: 12px;
          left: 16px; right: 16px; width: auto; transform: none;
        }
        .controls-below.visible {
          display: flex; flex-wrap: wrap; justify-content: center;
          gap: 12px;
        }
        .light { --light-size: ${Math.min(this._config.light_size, 50)}px; }
        .color-wheel-mini { order: 1; flex-shrink: 0; align-self: start; }
        .presets-area {
          order: 2; flex: 0 1 auto; align-self: center;
          margin-left: 0; /* Reset desktop alignment offset */
          max-width: calc(100% - 140px); /* 128px wheel + 12px gap */
        }
        .slider-group { order: 3; flex: 1 1 100%; min-width: 0; }
      }

      .empty-state {
        position: absolute; inset: 0; display: flex; flex-direction: column;
        align-items: center; justify-content: center; gap: 12px; pointer-events: none;
      }
      .empty-state-icon { color: var(--text-tertiary); opacity: 0.5; }
      .empty-state-title { font-size: 16px; font-weight: 600; color: var(--text-secondary); }
      .empty-state-text { font-size: 13px; color: var(--text-tertiary); text-align: center; max-width: 280px; line-height: 1.5; }

      .modal-close:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; }

      /* Large color wheel overlay */
      .color-wheel-overlay {
        position: fixed; inset: 0; background: rgba(0,0,0,0.88); backdrop-filter: blur(12px);
        display: none; flex-direction: column; align-items: center; justify-content: center;
        z-index: 1000; padding: 24px; gap: 20px;
      }
      .color-wheel-overlay.visible { display: flex; }
      .color-wheel-large-wrap {
        position: relative; display: flex; align-items: center; justify-content: center;
      }
      .color-wheel-large {
        width: min(75vmin, 380px); height: min(75vmin, 380px);
        border-radius: 9999px; cursor: crosshair;
        border: 3px solid rgba(255,255,255,0.15);
        box-shadow: 0 0 60px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.05);
        touch-action: none;
      }
      .color-wheel-footer {
        display: flex; align-items: center; gap: 16px;
      }
      .color-wheel-preview-swatch {
        width: 44px; height: 44px; border-radius: 9999px;
        border: 2.5px solid rgba(255,255,255,0.25);
        box-shadow: var(--shadow-md); transition: background-color 60ms ease, border-color 200ms ease;
        background: var(--surface-tertiary);
      }
      .color-wheel-done-btn {
        padding: 10px 32px; border: 1px solid rgba(255,255,255,0.12);
        background: var(--surface-elevated); color: var(--text-primary);
        font-size: 14px; font-weight: 600; font-family: var(--font-sans);
        border-radius: var(--radius-lg); cursor: pointer;
        transition: background var(--transition-fast), transform var(--transition-fast);
      }
      .color-wheel-done-btn:hover { background: var(--surface-tertiary); }
      .color-wheel-done-btn:active { transform: scale(0.96); }
      .color-wheel-hint {
        font-size: 12px; color: var(--text-tertiary); text-align: center;
        pointer-events: none; margin-top: -8px;
      }
      /* Magnifier loupe */
      .color-wheel-magnifier {
        position: fixed; width: 110px; height: 110px; border-radius: 9999px;
        border: 3px solid #fff; box-shadow: 0 4px 24px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.1);
        pointer-events: none; display: none; overflow: hidden; z-index: 1010;
        transition: border-color 60ms ease;
      }
      .color-wheel-magnifier.visible { display: block; }
      .color-wheel-magnifier canvas {
        width: 100%; height: 100%; border-radius: 9999px; display: block;
      }
      .color-wheel-magnifier-crosshair {
        position: absolute; inset: 0; pointer-events: none;
      }

      :host(.overlay-active) .light,
      :host(.overlay-active) .light.selected,
      :host(.overlay-active) .light.dragging,
      :host(.overlay-active) .light-label {
        z-index: 1;
      }
    `;
  }

  _renderHeader() {
    return `
      <div class="header">
        <div class="title">${this._config.title}</div>
      </div>
    `;
  }

  _resolveEntityColor(entity_id, isOn, attributes) {
    const [domain] = entity_id.split('.');
    const override = this._config.color_overrides?.[entity_id];

    // Helper to extract override based on state
    const getOverride = (state) => {
      if (!override) return null;
      if (typeof override === 'string') return state === 'on' ? override : null;
      if (state === 'on') return override.state_on || override.on || null;
      return override.state_off || override.off || null;
    };

    if (domain === 'scene') {
      const ov = getOverride('on') || (typeof override === 'string' ? override : null);
      return ov || this._config.scene_color;
    }

    if (isOn) {
      const ov = getOverride('on');
      if (ov) return ov;

      if (domain === 'switch' || domain === 'input_boolean') return this._config.switch_on_color;
      if (domain === 'binary_sensor') return this._config.binary_sensor_on_color;

      if (attributes && attributes.rgb_color) {
        const [r, g, b] = attributes.rgb_color;
        return `rgb(${r}, ${g}, ${b})`;
      }
      return '#ffa500';
    } else {
      const ov = getOverride('off');
      if (ov) return ov;

      if (domain === 'switch' || domain === 'input_boolean') return this._config.switch_off_color;
      if (domain === 'binary_sensor') return this._config.binary_sensor_off_color;
      return 'transparent';
    }
  }

  _renderEmptyState() {
    return `
      <div class="empty-state">
        <div class="empty-state-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 18h6"/>
            <path d="M10 22h4"/>
            <path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/>
          </svg>
        </div>
        <div class="empty-state-title">No entities configured</div>
        <div class="empty-state-text">Edit this card to add light entities and start building your spatial layout.</div>
      </div>
    `;
  }

  _renderLightsHTML() {
    return this._config.entities.map(entity_id => {
      const pos = this._config.positions[entity_id] || { x: 50, y: 50 };
      const st = this._hass?.states[entity_id];
      if (!st) return '';

      const [domain] = entity_id.split('.');
      const isOn = st.state === 'on';
      const isSelected = this._selectedLights.has(entity_id);
      const label = this._generateLabel(entity_id);

      const color = this._resolveEntityColor(entity_id, isOn, st.attributes);

      // Determine if this light should be icon-only
      const isIconOnly = this._config.icon_only_overrides[entity_id] !== undefined
        ? this._config.icon_only_overrides[entity_id]
        : this._config.icon_only_mode;

      // Minimal UI mode (no circles except when selected)
      const isMinimalUI = this._config.minimal_ui;

      // Icon-only or minimal-ui mode always shows icons; otherwise respect show_entity_icons
      const iconData = (isIconOnly || isMinimalUI || this._config.show_entity_icons) ? this._getEntityIconData(entity_id) : null;
      const stateClass = (domain === 'scene' || isOn) ? 'on' : 'off';
      const iconOnlyClass = isMinimalUI ? 'minimal-ui' : (isIconOnly ? 'icon-only' : '');

      // Build inline styles
      let style = `left:${pos.x}%; top:${pos.y}%;`;

      // Per-light size override
      const lightSize = this._config.size_overrides[entity_id] || this._config.light_size;
      if (lightSize !== this._config.light_size) {
        style += `--light-size:${lightSize}px;`;
      }

      // Scale icon based on size
      const iconScale = lightSize / 56; // 56 is the default size
      if (iconScale !== 1) {
        style += `--icon-scale:${iconScale.toFixed(2)};`;
      }

      // Icon rotation/mirror transform
      const iconTransform = this._getIconTransform(entity_id);
      if (iconTransform) {
        style += `--icon-transform:${iconTransform};`;
      }

      // Set light color CSS variable for icon-only/minimal-ui modes
      if ((isIconOnly || isMinimalUI) && color !== 'transparent') {
        style += `--light-color:${color};`;
      } else if (!isIconOnly && !isMinimalUI) {
        if (color !== 'transparent') {
          style += `background:${color};`;
        } else {
          style += `background:`; // Allow CSS gradient fallback
        }
      }

      return `
        <div class="light ${stateClass} ${isSelected ? 'selected' : ''} ${iconOnlyClass}"
             style="${style}"
             data-entity="${entity_id}"
             tabindex="0"
             role="button"
             aria-label="${st.attributes.friendly_name || entity_id}"
             aria-pressed="${isSelected}">
          ${iconData ? this._renderIcon(iconData) : ''}
          <div class="light-label">${label}</div>
        </div>
      `;
    }).join('');
  }

  _renderControlsFloating(visible, controlContext) {
    const { avgState, tempRange } = controlContext;
    const clampedTemp = this._clampTemperature(avgState.temperature, tempRange);
    const brightnessPercent = Math.min(100, Math.max(0, (avgState.brightness / 255) * 100));
    const tempPercent = (tempRange.max > tempRange.min)
      ? Math.min(100, Math.max(0, ((clampedTemp - tempRange.min) / (tempRange.max - tempRange.min)) * 100))
      : 0;
    const brightnessColor = Array.isArray(avgState.color) ? `rgb(${avgState.color.join(',')})` : 'var(--accent-primary)';
    return `
      <div class="controls-floating ${visible ? 'visible' : ''}" id="controlsFloating" role="region" aria-label="Light controls" aria-live="polite">
        <canvas id="colorWheelMini" class="color-wheel-mini" width="256" height="256" role="img" aria-label="Color picker"></canvas>
        <div class="slider-group">
          <div class="slider-row">
            <input type="range" class="slider" id="brightnessSlider" min="0" max="255" value="${avgState.brightness}" aria-label="Brightness" style="--slider-percent:${brightnessPercent}%;--slider-ratio:${brightnessPercent/100};--slider-fill:${brightnessColor};">
            <span class="slider-value" id="brightnessValue">${Math.round((avgState.brightness/255)*100)}%</span>
          </div>
          <div class="slider-row">
            <input type="range" class="slider temperature" id="temperatureSlider" min="${tempRange.min}" max="${tempRange.max}" value="${clampedTemp}" aria-label="Color temperature" style="--slider-percent:${tempPercent}%;--slider-ratio:${tempPercent/100};">
            <span class="slider-value" id="temperatureValue">${clampedTemp}K</span>
          </div>
        </div>
        <div class="presets-area">
          ${this._renderPresetsContent()}
        </div>
      </div>
    `;
  }

  _renderControlsBelow(controlContext) {
    const { avgState, tempRange } = controlContext;
    const clampedTemp = this._clampTemperature(avgState.temperature, tempRange);
    const brightnessPercent = Math.min(100, Math.max(0, (avgState.brightness / 255) * 100));
    const tempPercent = (tempRange.max > tempRange.min)
      ? Math.min(100, Math.max(0, ((clampedTemp - tempRange.min) / (tempRange.max - tempRange.min)) * 100))
      : 0;
    const brightnessColor = Array.isArray(avgState.color) ? `rgb(${avgState.color.join(',')})` : 'var(--accent-primary)';
    return `
      <div class="controls-below" id="controlsBelow" role="region" aria-label="Light controls" aria-live="polite">
        <canvas id="colorWheelMini" class="color-wheel-mini" width="256" height="256" role="img" aria-label="Color picker"></canvas>
        <div class="slider-group">
          <div class="slider-row">
            <input type="range" class="slider" id="brightnessSlider" min="0" max="255" value="${avgState.brightness}" aria-label="Brightness" style="--slider-percent:${brightnessPercent}%;--slider-ratio:${brightnessPercent/100};--slider-fill:${brightnessColor};">
            <span class="slider-value" id="brightnessValue">${Math.round((avgState.brightness/255)*100)}%</span>
          </div>
          <div class="slider-row">
            <input type="range" class="slider temperature" id="temperatureSlider" min="${tempRange.min}" max="${tempRange.max}" value="${clampedTemp}" aria-label="Color temperature" style="--slider-percent:${tempPercent}%;--slider-ratio:${tempPercent/100};">
            <span class="slider-value" id="temperatureValue">${clampedTemp}K</span>
          </div>
        </div>
        <div class="presets-area">
          ${this._renderPresetsContent()}
        </div>
      </div>
    `;
  }

  _renderYamlModal() {
    return `
      <div class="modal-overlay ${this._yamlModalOpen ? 'visible' : ''}" id="yamlModal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
        <div class="modal">
          <div class="modal-header">
            <span class="modal-title" id="modalTitle">Configuration YAML</span>
            <button class="modal-close" id="closeModal" aria-label="Close">×</button>
          </div>
          <div class="yaml-output" id="yamlOutput" role="textbox" aria-multiline="true" aria-readonly="true">${this._generateYAML()}</div>
          <div class="modal-hint">Select all (Cmd/Ctrl+A) and copy (Cmd/Ctrl+C)</div>
        </div>
      </div>
    `;
  }

  _renderLargeColorWheel() {
    return `
      <div class="color-wheel-overlay" id="colorWheelOverlay">
        <div class="color-wheel-large-wrap">
          <canvas class="color-wheel-large" id="colorWheelLarge" width="512" height="512"></canvas>
        </div>
        <div class="color-wheel-footer">
          <div class="color-wheel-preview-swatch" id="colorWheelPreviewSwatch"></div>
          <button class="color-wheel-done-btn" id="colorWheelDoneBtn">Done</button>
        </div>
        <div class="color-wheel-hint">Drag to pick a color</div>
        <div class="color-wheel-magnifier" id="colorWheelMagnifier">
          <canvas id="colorWheelMagnifierCanvas" width="220" height="220"></canvas>
        </div>
      </div>
    `;
  }

  _updateControlValues(controlContext) {
    const context = controlContext || { avgState: { brightness: 128, temperature: 4000 }, tempRange: { min: 2000, max: 6500 } };
    const { avgState, tempRange } = context;
    const brightness = Number.isFinite(avgState?.brightness) ? avgState.brightness : 128;
    const temperature = Number.isFinite(avgState?.temperature)
      ? this._clampTemperature(avgState.temperature, tempRange)
      : this._clampTemperature(4000, tempRange);
    const brightnessPercent = Math.min(100, Math.max(0, (brightness / 255) * 100));
    const tempPercent = (tempRange.max > tempRange.min)
      ? Math.min(100, Math.max(0, ((temperature - tempRange.min) / (tempRange.max - tempRange.min)) * 100))
      : 0;
    const brightnessColor = Array.isArray(avgState?.color) ? `rgb(${avgState.color.join(',')})` : 'var(--accent-primary)';

    if (this._els.brightnessSlider) {
      this._els.brightnessSlider.value = String(brightness);
      this._els.brightnessSlider.style.setProperty('--slider-percent', `${brightnessPercent}%`);
      this._els.brightnessSlider.style.setProperty('--slider-ratio', `${brightnessPercent / 100}`);
      this._els.brightnessSlider.style.setProperty('--slider-fill', brightnessColor);
    }
    if (this._els.brightnessValue) {
      this._els.brightnessValue.textContent = `${Math.round((brightness / 255) * 100)}%`;
    }
    if (this._els.temperatureSlider) {
      if (this._els.temperatureSlider.min !== String(tempRange.min)) {
        this._els.temperatureSlider.min = String(tempRange.min);
      }
      if (this._els.temperatureSlider.max !== String(tempRange.max)) {
        this._els.temperatureSlider.max = String(tempRange.max);
      }
      this._els.temperatureSlider.value = String(temperature);
      this._els.temperatureSlider.style.setProperty('--slider-percent', `${tempPercent}%`);
      this._els.temperatureSlider.style.setProperty('--slider-ratio', `${tempPercent / 100}`);
    }
    if (this._els.temperatureValue) {
      this._els.temperatureValue.textContent = `${temperature}K`;
    }
  }

  _updateSliderVisual(el) {
    if (!el) return;
    const min = parseFloat(el.min || '0');
    const max = parseFloat(el.max || '100');
    const val = parseFloat(el.value || '0');
    const percent = Number.isFinite(min) && Number.isFinite(max) && max > min
      ? Math.min(100, Math.max(0, ((val - min) / (max - min)) * 100))
      : 0;
    el.style.setProperty('--slider-percent', `${percent}%`);
    el.style.setProperty('--slider-ratio', `${percent / 100}`);
  }

  _bindSliderGesture(el) {
    if (!el) return;

    const updateVisuals = () => {
      this._updateSliderVisual(el);
      // Manually update labels since programmatic changes don't fire input events
      if (el.id === 'brightnessSlider' && this._els.brightnessValue) {
        const pct = Math.round((parseInt(el.value, 10) / 255) * 100);
        this._els.brightnessValue.textContent = `${pct}%`;
      } else if (el.id === 'temperatureSlider' && this._els.temperatureValue) {
        this._els.temperatureValue.textContent = `${el.value}K`;
      }
    };

    const state = {
      pointerId: null,
      startX: 0,
      startY: 0,
      startValue: null,
      isScrolling: false,
      locked: false
    };

    el.addEventListener('pointerdown', (e) => {
      // Prevent default browser dragging to ensure we handle the gesture
      e.preventDefault();
      el.setPointerCapture(e.pointerId);

      state.pointerId = e.pointerId;
      state.startX = e.clientX;
      state.startY = e.clientY;
      state.startValue = el.value;
      state.isScrolling = false;
      state.locked = false;

      // Immediate update on tap start
      this._applyPointerValue(el, e.clientX);
      updateVisuals();
    });

    el.addEventListener('pointermove', (e) => {
      if (state.pointerId !== e.pointerId) return;
      if (state.isScrolling) return;

      const dx = Math.abs(e.clientX - state.startX);
      const dy = Math.abs(e.clientY - state.startY);

      // Check for scroll intent if not yet locked
      if (!state.locked && (dx > 6 || dy > 6)) {
        state.locked = true;
        if (dy > dx) {
          // Vertical scroll detected - Revert interaction
          state.isScrolling = true;
          el.value = state.startValue;
          updateVisuals();
          el.releasePointerCapture(e.pointerId);
          return;
        }
      }

      // If we aren't scrolling, follow the finger
      this._applyPointerValue(el, e.clientX);
      updateVisuals();
    });

    const endInteraction = (e) => {
      if (state.pointerId !== e.pointerId) return;
      el.releasePointerCapture(e.pointerId);
      state.pointerId = null;

      if (!state.isScrolling) {
        // Commit change
        if (el.id === 'brightnessSlider') {
          this._pendingBrightness = parseInt(el.value, 10);
          this._handleBrightnessChange();
        } else if (el.id === 'temperatureSlider') {
          this._pendingTemperature = parseInt(el.value, 10);
          this._handleTemperatureChange();
        }
      }
    };

    el.addEventListener('pointerup', endInteraction);
    el.addEventListener('pointercancel', endInteraction);
  }

  _applyPointerValue(el, clientX) {
    const rect = el.getBoundingClientRect();
    const min = parseFloat(el.min);
    const max = parseFloat(el.max);
    
    // The thumb size matches CSS --slider-thumb-size: 26px
    const thumbSize = 26;
    
    // Calculate the effective travel distance of the thumb's center
    const availableWidth = rect.width - thumbSize;
    
    // Offset relative to the start of the travel area
    const offset = clientX - rect.left - (thumbSize / 2);
    
    let pct = 0;
    if (availableWidth > 0) {
      pct = offset / availableWidth;
    }
    
    pct = Math.max(0, Math.min(1, pct));
    el.value = Math.round(min + pct * (max - min));
  }

  /** ---------- Events ---------- */
  connectedCallback() {
    if (!this._boundKeyDown) {
      this._boundKeyDown = (e) => this._handleKeyDown(e);
      document.addEventListener('keydown', this._boundKeyDown);
    }
    if (typeof window !== 'undefined') {
      this._boundIconsetAdded = () => this._refreshEntityIcons();
      window.addEventListener('iron-iconset-added', this._boundIconsetAdded);
      this._boundMoreInfo = (event) => {
        if (event.detail && 'entityId' in event.detail) {
          this._moreInfoOpen = Boolean(event.detail.entityId);
          this._syncOverlayState();
        }
      };
      window.addEventListener('hass-more-info', this._boundMoreInfo, { passive: true });
    }
  }
  disconnectedCallback() {
    if (this._boundKeyDown) {
      document.removeEventListener('keydown', this._boundKeyDown);
      this._boundKeyDown = null;
    }
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._boundIconsetAdded && typeof window !== 'undefined') {
      window.removeEventListener('iron-iconset-added', this._boundIconsetAdded);
      this._boundIconsetAdded = null;
    }
    if (this._boundMoreInfo && typeof window !== 'undefined') {
      window.removeEventListener('hass-more-info', this._boundMoreInfo);
      this._boundMoreInfo = null;
    }
    if (this._longPressTimer) {
      clearTimeout(this._longPressTimer);
      this._longPressTimer = null;
    }
    if (this._iconRefreshHandle) {
      clearTimeout(this._iconRefreshHandle);
      this._iconRefreshHandle = null;
    }
    if (this._iconRehydrateHandle) {
      clearTimeout(this._iconRehydrateHandle);
      this._iconRehydrateHandle = null;
    }
    if (this._colorWheelObserver) {
      this._colorWheelObserver.disconnect();
      this._colorWheelObserver = null;
    }
    if (this._colorWheelFrame) {
      const cancel = this._colorWheelCancel || (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout);
      cancel(this._colorWheelFrame);
      this._colorWheelFrame = null;
    }
    this._pendingTap = null;
    this._longPressTriggered = false;
    this._moreInfoOpen = false;
    this._largeColorWheelOpen = false;
    if (this._colorWheelLongPressTimer) {
      clearTimeout(this._colorWheelLongPressTimer);
      this._colorWheelLongPressTimer = null;
    }
    this._colorWheelLongPressed = false;
    this._largeWheelGesture = null;
    this.classList.remove('overlay-active');
  }

  _attachEventListeners() {
    // Pointer events on canvas (unified)
    if (this._els.canvas) {
      this._els.canvas.addEventListener('pointerdown', (e) => this._onPointerDown(e));
      this._els.canvas.addEventListener('pointermove', (e) => this._onPointerMove(e));
      this._els.canvas.addEventListener('pointerup', (e) => this._onPointerUp(e));
      this._els.canvas.addEventListener('pointercancel', (e) => this._onPointerCancel(e));
      this._els.canvas.addEventListener('dblclick', (e) => this._handleCanvasDoubleClick(e));
      this._els.canvas.addEventListener('contextmenu', (e) => this._handleCanvasContextMenu(e));
    }

    // Modal close
    const closeModal = this.shadowRoot.getElementById('closeModal');
    if (closeModal) {
      closeModal.addEventListener('click', () => {
        this._yamlModalOpen = false;
        if (this._els.yamlModal) this._els.yamlModal.classList.remove('visible');
        this._syncOverlayState();
      });
    }
    if (this._els.yamlModal) {
      this._els.yamlModal.addEventListener('click', (e) => {
        if (e.target === this._els.yamlModal) {
          this._yamlModalOpen = false;
          this._els.yamlModal.classList.remove('visible');
          this._syncOverlayState();
        }
      });
    }

    // Controls events
    if (this._els.colorWheel) {
      this._els.colorWheel.addEventListener('pointerdown', (e) => {
        const isTouchLike = e.pointerType === 'touch' || e.pointerType === 'pen' || !e.pointerType;
        this._colorWheelActive = true;
        this._colorWheelLongPressed = false;
        this._colorWheelGesture = {
          pointerId: e.pointerId,
          isTouch: isTouchLike,
          startScroll: this._getScrollPosition(),
          scrolled: false,
          pendingColor: null,
          longPressActive: true,  // defer all color application while long-press might fire
        };
        e.preventDefault();
        e.target.setPointerCapture?.(e.pointerId);

        // Long-press detection for large color wheel
        if (this._colorWheelLongPressTimer) clearTimeout(this._colorWheelLongPressTimer);
        this._colorWheelLongPressStart = { x: e.clientX, y: e.clientY };
        const longPressDelay = isTouchLike ? 400 : 600;
        this._colorWheelLongPressTimer = setTimeout(() => {
          this._colorWheelLongPressTimer = null;
          this._colorWheelLongPressed = true;
          this._colorWheelActive = false;
          e.target.releasePointerCapture?.(e.pointerId);
          if (navigator.vibrate) navigator.vibrate(30);
          this._openLargeColorWheel();
        }, longPressDelay);

        // Always store as pending — never apply immediately during long-press window
        const color = this._getColorWheelColorAtEvent(e);
        if (color) this._colorWheelGesture.pendingColor = color;
      });
      this._els.colorWheel.addEventListener('pointermove', (e) => {
        if (this._colorWheelActive) {
          const gesture = this._colorWheelGesture;
          if (!gesture || (gesture.pointerId !== undefined && gesture.pointerId !== e.pointerId)) return;

          // Cancel long-press if finger/pointer moved too far
          if (this._colorWheelLongPressTimer && this._colorWheelLongPressStart) {
            const dx = e.clientX - this._colorWheelLongPressStart.x;
            const dy = e.clientY - this._colorWheelLongPressStart.y;
            if (Math.sqrt(dx * dx + dy * dy) > 8) {
              clearTimeout(this._colorWheelLongPressTimer);
              this._colorWheelLongPressTimer = null;
              gesture.longPressActive = false;
              // Now that long-press is cancelled, apply the deferred pending color (mouse only)
              if (!gesture.isTouch && gesture.pendingColor) {
                this._applyColorWheelSelection(gesture.pendingColor);
              }
            }
          }

          const scrollPos = this._getScrollPosition();
          if (scrollPos.x !== gesture.startScroll.x || scrollPos.y !== gesture.startScroll.y) {
            gesture.scrolled = true;
            if (this._colorWheelLongPressTimer) { clearTimeout(this._colorWheelLongPressTimer); this._colorWheelLongPressTimer = null; }
            return;
          }

          const color = this._getColorWheelColorAtEvent(e);
          if (!color) return;

          if (gesture.isTouch) {
            gesture.pendingColor = color;
          } else if (!gesture.longPressActive) {
            // Only apply immediately for mouse after long-press window has passed
            e.preventDefault();
            this._applyColorWheelSelection(color);
          } else {
            gesture.pendingColor = color;
          }
        }
      });
      this._els.colorWheel.addEventListener('pointerup', (e) => {
        // Cancel any pending long-press timer
        if (this._colorWheelLongPressTimer) { clearTimeout(this._colorWheelLongPressTimer); this._colorWheelLongPressTimer = null; }

        this._colorWheelActive = false;
        e.target.releasePointerCapture?.(e.pointerId);

        // If long press triggered, don't apply color from mini wheel
        if (this._colorWheelLongPressed) {
          this._colorWheelLongPressed = false;
          this._colorWheelGesture = null;
          return;
        }

        const gesture = this._colorWheelGesture;
        this._colorWheelGesture = null;
        if (!gesture || gesture.pointerId !== e.pointerId) return;

        // Apply pending color on release (for both touch and mouse with deferred long-press)
        if (!gesture.scrolled) {
          const color = this._getColorWheelColorAtEvent(e) || gesture.pendingColor;
          if (color) this._applyColorWheelSelection(color);
        }
      });
      this._els.colorWheel.addEventListener('pointercancel', (e) => {
        if (this._colorWheelLongPressTimer) { clearTimeout(this._colorWheelLongPressTimer); this._colorWheelLongPressTimer = null; }
        this._colorWheelActive = false;
        this._colorWheelLongPressed = false;
        e.target.releasePointerCapture?.(e.pointerId);
        this._colorWheelGesture = null;
      });
    }
    // Preset click and highlight handlers (color + temperature)
    this._bindPresetHandlers();
    if (this._els.brightnessSlider) {
      // Input/Change listeners kept for keyboard support but logic dominated by pointer events
      this._els.brightnessSlider.addEventListener('input', (e) => this._handleBrightnessInput(e));
      this._els.brightnessSlider.addEventListener('change', () => this._handleBrightnessChange());
      this._bindSliderGesture(this._els.brightnessSlider);
    }
    if (this._els.temperatureSlider) {
      this._els.temperatureSlider.addEventListener('input', (e) => this._handleTemperatureInput(e));
      this._els.temperatureSlider.addEventListener('change', () => this._handleTemperatureChange());
      this._bindSliderGesture(this._els.temperatureSlider);
    }
  }

  _rerenderLightIconsOnly() {
    const nodes = this.shadowRoot.querySelectorAll('.light');
    nodes.forEach(light => {
      const entity = light.dataset.entity;
      const iconWrap = light.querySelector('.light-icon, ha-icon, ha-svg-icon, .light-icon-emoji');
      if (iconWrap) iconWrap.remove();
      if (this._config.show_entity_icons || this._config.icon_only_mode) {
        const iconData = this._getEntityIconData(entity);
        light.insertAdjacentHTML('afterbegin', this._renderIcon(iconData));
      }
    });
    this._refreshEntityIcons();
  }

  _rerenderLightsForDisplayMode() {
    // Re-render lights to apply icon-only mode changes
    const nodes = this.shadowRoot.querySelectorAll('.light');
    nodes.forEach(light => {
      const entity_id = light.dataset.entity;
      const st = this._hass?.states[entity_id];
      if (!st) return;

      const [domain] = entity_id.split('.');
      const isOn = st.state === 'on';
      const color = this._resolveEntityColor(entity_id, isOn, st.attributes);

      // Determine if this light should be icon-only
      const isIconOnly = this._config.icon_only_overrides[entity_id] !== undefined
        ? this._config.icon_only_overrides[entity_id]
        : this._config.icon_only_mode;

      // Toggle icon-only class
      light.classList.toggle('icon-only', isIconOnly);

      // Update background/color styling
      if (isIconOnly) {
        light.style.background = 'transparent';
        if (color !== 'transparent') {
          light.style.setProperty('--light-color', color);
        }
      } else {
        light.style.removeProperty('--light-color');
        if (color !== 'transparent') {
          light.style.background = color;
        } else {
          light.style.background = '';
        }
      }

      // Ensure icons are present in icon-only mode
      const iconWrap = light.querySelector('.light-icon, ha-icon, ha-svg-icon, .light-icon-emoji');
      if (isIconOnly && !iconWrap) {
        const iconData = this._getEntityIconData(entity_id);
        light.insertAdjacentHTML('afterbegin', this._renderIcon(iconData));
      } else if (!isIconOnly && !this._config.show_entity_icons && iconWrap) {
        iconWrap.remove();
      }
    });
    this._refreshEntityIcons();
  }

  _updateLightSizes() {
    // Update all light sizes via CSS custom property
    const nodes = this.shadowRoot.querySelectorAll('.light');
    const defaultSize = this._config.light_size;
    const defaultIconScale = defaultSize / 56;

    nodes.forEach(light => {
      const entity_id = light.dataset.entity;
      const lightSize = this._config.size_overrides[entity_id] || defaultSize;
      const iconScale = lightSize / 56;

      // Apply size
      light.style.setProperty('--light-size', `${lightSize}px`);
      light.style.setProperty('--icon-scale', iconScale.toFixed(2));
    });
  }

  _commitSelection(newSelection) {
    const updatedSelection = new Set(newSelection);
    this._selectedLights.clear();
    updatedSelection.forEach(entity => this._selectedLights.add(entity));
    this.updateLights();
    const shouldDrawWheel =
      (this._config.always_show_controls || this._selectedLights.size > 0 || this._config.default_entity) &&
      Boolean(this._els.colorWheel);
    if (shouldDrawWheel) {
      this._requestColorWheelDraw();
    }
  }

  /** ---------- Keyboard ---------- */
  _handleKeyDown(e) {
    // Undo/Redo
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); this._undo(); }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'Z' && e.shiftKey))) { e.preventDefault(); this._redo(); }
    // Escape → deselect and close panels
    if (e.key === 'Escape') {
      // Close large color wheel first if open
      if (this._largeColorWheelOpen) {
        this._closeLargeColorWheel();
        return;
      }
      this._selectedLights.clear();
      if (this._yamlModalOpen) this._yamlModalOpen = false;
      if (this._els.yamlModal) this._els.yamlModal.classList.remove('visible');
      if (this._moreInfoOpen) {
        this.dispatchEvent(new CustomEvent('hass-more-info', {
          detail: { entityId: null },
          bubbles: true,
          composed: true,
        }));
      }
      this._moreInfoOpen = false;
      this._syncOverlayState();
      this.updateLights();
    }
    // Select all
    if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
      e.preventDefault();
      this._selectedLights.clear();
      this._config.entities.forEach(ent => this._selectedLights.add(ent));
      this.updateLights();
      if (this._els.colorWheel) this._requestColorWheelDraw();
    }
    // Optional: movement with arrows if unlocked
    if ((!this._lockPositions || this._editPositionsMode) && this._selectedLights.size > 0) {
      const step = e.altKey ? 1 : 0.5; // fine control with Alt
      let moved = false;
      const delta = { x: 0, y: 0 };
      if (e.key === 'ArrowLeft') { delta.x = -step; moved = true; }
      if (e.key === 'ArrowRight') { delta.x = step; moved = true; }
      if (e.key === 'ArrowUp') { delta.y = -step; moved = true; }
      if (e.key === 'ArrowDown') { delta.y = step; moved = true; }
      if (moved) {
        e.preventDefault();
        this._selectedLights.forEach(entity => {
          const pos = this._config.positions[entity] || { x: 50, y: 50 };
          const nx = Math.max(0, Math.min(100, pos.x + delta.x));
          const ny = Math.max(0, Math.min(100, pos.y + delta.y));
          this._config.positions[entity] = { x: nx, y: ny };
        });
        this._smoothApplyPositions();
        this._saveHistory();
        if (this._editPositionsMode && this._editorId) {
          window.dispatchEvent(new CustomEvent('spatial-card-positions-changed', {
            detail: {
              editorId: this._editorId,
              positions: JSON.parse(JSON.stringify(this._config.positions)),
            },
          }));
        }
      }
    }
  }

  /** ---------- Pointer (unified mouse/touch/pen) ---------- */
  _onPointerDown(e) {
    if (!this._els.canvas) return;
    e.target.setPointerCapture?.(e.pointerId);

    const targetLight = e.target.closest('.light');
    if (targetLight) {
      const entity = targetLight.dataset.entity;
      const pointerType = e.pointerType || 'mouse';
      const [domain] = entity.split('.');
      // Check if this entity type is configured to toggle on single tap
      const toggleOnSingleTap = this._config.switch_single_tap && (domain === 'switch' || domain === 'input_boolean' || domain === 'scene');
      
      if (this._lockPositions && !this._editPositionsMode) {
        const additive = e.shiftKey || e.ctrlKey || e.metaKey;
        if (this._longPressTimer) {
          clearTimeout(this._longPressTimer);
          this._longPressTimer = null;
        }
        this._longPressTriggered = false;
        const longPressDelay = pointerType === 'mouse' ? 650 : 500;
        this._longPressTimer = setTimeout(() => {
          this._longPressTimer = null;
          this._longPressTriggered = true;
          this._pendingTap = null;
          this._lastTap = null;
          if (pointerType !== 'mouse' && typeof navigator !== 'undefined' && navigator.vibrate) {
            navigator.vibrate(30);
          }
          this._openMoreInfo(entity);
        }, longPressDelay);
        if (pointerType === 'touch' || pointerType === 'pen') {
          this._pendingTap = {
            entity,
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            additive,
            pointerType,
            toggleOnSingleTap,
          };
        } else {
          if (toggleOnSingleTap) {
            const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            const isRepeat = this._lastTap && this._lastTap.entity === entity && (now - this._lastTap.time) < 350;
            if (!isRepeat) {
              this._toggleEntity(entity);
            }
            this._lastTap = { entity, time: now };
            return;
          }
          const newSelection = new Set(this._selectedLights);
          if (additive) {
            if (newSelection.has(entity)) newSelection.delete(entity);
            else newSelection.add(entity);
          } else {
            newSelection.clear();
            newSelection.add(entity);
          }
          this._commitSelection(newSelection);
        }
        return;
      }

      if (!this._selectedLights.has(entity)) {
        const additive = e.shiftKey || e.ctrlKey || e.metaKey;
        const newSelection = new Set(this._selectedLights);
        if (!additive) newSelection.clear();
        newSelection.add(entity);
        this._commitSelection(newSelection);
      }

      this._pendingTap = null;
      if (this._longPressTimer) {
        clearTimeout(this._longPressTimer);
        this._longPressTimer = null;
      }
      this._longPressTriggered = false;

      // Begin drag
      const rect = this._els.canvas.getBoundingClientRect();
      this._dragState = {
        entity,
        startX: e.clientX,
        startY: e.clientY,
        initialLeft: parseFloat(targetLight.style.left),
        initialTop: parseFloat(targetLight.style.top),
        rect,
        moved: false,
      };
      targetLight.classList.add('dragging');
      // Pre-history snapshot if necessary
      this._saveHistory();
      return;
    }

    // Start canvas selection rubberband
    if (e.target.id === 'canvas' || e.target.classList.contains('grid')) {
      const rect = this._els.canvas.getBoundingClientRect();
      this._selectionStart = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      this._selectionBox = document.createElement('div');
      this._selectionBox.className = 'selection-box';
      this._els.canvas.appendChild(this._selectionBox);
      this._selectionModeAdditive = e.shiftKey || e.ctrlKey || e.metaKey;
      this._selectionBase = this._selectionModeAdditive ? new Set(this._selectedLights) : null;
      if (!this._selectionModeAdditive) {
        this._selectedLights.clear();
        this.updateLights();
      }
    }
  }

  _onPointerMove(e) {
    if (this._pendingTap && e.pointerId === this._pendingTap.pointerId) {
      const dx = e.clientX - this._pendingTap.startX;
      const dy = e.clientY - this._pendingTap.startY;
      if (Math.hypot(dx, dy) > 12) {
        if (this._longPressTimer) {
          clearTimeout(this._longPressTimer);
          this._longPressTimer = null;
        }
        this._pendingTap = null;
        this._lastTap = null;
      }
    }

    if (this._dragState) {
      e.preventDefault();
      if (this._raf) cancelAnimationFrame(this._raf);
      this._raf = requestAnimationFrame(() => {
        this._raf = null;
        const { rect, startX, startY, initialLeft, initialTop, entity } = this._dragState;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this._dragState.moved = true;

        let xPercent = initialLeft + (dx / rect.width) * 100;
        let yPercent = initialTop + (dy / rect.height) * 100;
        const snapped = this._snapToGrid(xPercent, yPercent, e);
        xPercent = Math.max(0, Math.min(100, snapped.x));
        yPercent = Math.max(0, Math.min(100, snapped.y));

        const node = this.shadowRoot.querySelector(`.light[data-entity="${entity}"]`);
        if (node) {
          node.style.left = `${xPercent}%`;
          node.style.top = `${yPercent}%`;
        }
      });
      return;
    }

    if (this._selectionBox && this._selectionStart) {
      e.preventDefault();
      const rect = this._els.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const left = Math.min(this._selectionStart.x, x);
      const top = Math.min(this._selectionStart.y, y);
      const width = Math.abs(x - this._selectionStart.x);
      const height = Math.abs(y - this._selectionStart.y);
      Object.assign(this._selectionBox.style, {
        left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`,
      });
      this._selectLightsInBox(left, top, width, height);
    }
  }

  _onPointerUp(e) {
    e.target.releasePointerCapture?.(e.pointerId);
    if (this._dragState) {
      const { entity, moved } = this._dragState;
      const node = this.shadowRoot.querySelector(`.light[data-entity="${entity}"]`);
      if (node) {
        node.classList.remove('dragging');
        const finalLeft = parseFloat(node.style.left);
        const finalTop = parseFloat(node.style.top);
        this._config.positions[entity] = { x: finalLeft, y: finalTop };
      }
      if (moved) {
        this._saveHistory();
        // Notify editor of position changes when in edit mode
        if (this._editPositionsMode && this._editorId) {
          window.dispatchEvent(new CustomEvent('spatial-card-positions-changed', {
            detail: {
              editorId: this._editorId,
              positions: JSON.parse(JSON.stringify(this._config.positions)),
            },
          }));
        }
      }
      this._dragState = null;
    }

    if (this._selectionBox) {
      this._selectionBox.remove();
      this._selectionBox = null;
      this._selectionStart = null;
      this._selectionBase = null;
      this._selectionModeAdditive = false;
    }

    if (this._longPressTimer) {
      clearTimeout(this._longPressTimer);
      this._longPressTimer = null;
    }

    if (this._pendingTap && e.pointerId === this._pendingTap.pointerId) {
      if (!this._longPressTriggered) {
        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const isTouch = this._pendingTap.pointerType === 'touch' || this._pendingTap.pointerType === 'pen';
        if (this._pendingTap.toggleOnSingleTap) {
          const isRepeat = this._lastTap && this._lastTap.entity === this._pendingTap.entity && (now - this._lastTap.time) < 350;
          if (!isRepeat) {
            this._toggleEntity(this._pendingTap.entity);
          }
          this._lastTap = { entity: this._pendingTap.entity, time: now };
        } else if (isTouch && this._lastTap && this._lastTap.entity === this._pendingTap.entity && (now - this._lastTap.time) < 350) {
          this._toggleEntity(this._pendingTap.entity);
          this._lastTap = null;
        } else {
          if (isTouch) {
            this._lastTap = { entity: this._pendingTap.entity, time: now };
          } else {
            this._lastTap = null;
          }
          const newSelection = this._pendingTap.additive
            ? new Set(this._selectedLights)
            : new Set();
          if (this._pendingTap.additive && newSelection.has(this._pendingTap.entity)) {
            newSelection.delete(this._pendingTap.entity);
          } else {
            newSelection.add(this._pendingTap.entity);
          }
          this._commitSelection(newSelection);
        }
      }
      this._pendingTap = null;
    }

    this._longPressTriggered = false;
  }

  _onPointerCancel() {
    this._cancelActiveInteractions();
  }

  _handleCanvasDoubleClick(e) {
    const targetLight = e.target.closest('.light');
    if (!targetLight) return;
    const entity = targetLight.dataset.entity;
    if (!entity) return;
    const [domain] = entity.split('.');
    if (this._config.switch_single_tap && (domain === 'switch' || domain === 'input_boolean' || domain === 'scene')) {
      return;
    }
    e.preventDefault();
    this._toggleEntity(entity);
    this._lastTap = null;
  }

  _handleCanvasContextMenu(e) {
    const targetLight = e.target.closest('.light');
    if (!targetLight) return;
    const entity = targetLight.dataset.entity;
    if (!entity) return;
    e.preventDefault();
    this._openMoreInfo(entity);
    this._lastTap = null;
  }

  _cancelActiveInteractions() {
    this._dragState = null;
    if (this.shadowRoot) {
      this.shadowRoot.querySelectorAll('.light.dragging').forEach(node => node.classList.remove('dragging'));
    }
    if (this._selectionBox) {
      this._selectionBox.remove();
      this._selectionBox = null;
    }
    this._selectionBase = null;
    this._selectionModeAdditive = false;
    if (this._longPressTimer) {
      clearTimeout(this._longPressTimer);
      this._longPressTimer = null;
    }
    this._pendingTap = null;
    this._longPressTriggered = false;
  }

  _selectLightsInBox(left, top, width, height) {
    const lights = this.shadowRoot.querySelectorAll('.light');
    const rect = this._els.canvas.getBoundingClientRect();
    const inside = new Set();
    lights.forEach(light => {
      const r = light.getBoundingClientRect();
      const cx = r.left - rect.left + r.width / 2;
      const cy = r.top - rect.top + r.height / 2;
      if (cx >= left && cx <= left + width && cy >= top && cy <= top + height) {
        inside.add(light.dataset.entity);
      }
    });
    if (this._selectionModeAdditive && this._selectionBase) {
      this._commitSelection(new Set([...this._selectionBase, ...inside]));
    } else {
      this._commitSelection(inside);
    }
  }

  _syncOverlayState() {
    const overlayActive = this._yamlModalOpen || this._moreInfoOpen || this._largeColorWheelOpen;
    this.classList.toggle('overlay-active', overlayActive);
  }

  /** ---------- Color control ---------- */
  _getScrollPosition() {
    if (typeof window === 'undefined') return { x: 0, y: 0 };
    const x = typeof window.scrollX === 'number' ? window.scrollX : window.pageXOffset || 0;
    const y = typeof window.scrollY === 'number' ? window.scrollY : window.pageYOffset || 0;
    return { x, y };
  }

  _getColorWheelColorAtEvent(e) {
    const canvas = this._els.colorWheel;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const imageData = ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1);
    const [r, g, b, a] = imageData.data;
    if (a === 0) return null; // click outside painted area (shouldn't happen with full wheel)

    return [r, g, b];
  }

  _hexToRgb(hex) {
    if (!hex) return null;
    const h = hex.replace('#', '');
    if (h.length === 3) {
      return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
    }
    if (h.length === 6) {
      return [parseInt(h.substring(0, 2), 16), parseInt(h.substring(2, 4), 16), parseInt(h.substring(4, 6), 16)];
    }
    return null;
  }

  _rgbDistance(a, b) {
    const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
    return Math.sqrt(dr * dr + dg * dg + db * db);
  }

  _getLiveColors() {
    const COLOR_TOLERANCE = 30;
    const colors = [];
    // Color modes that indicate an actual RGB color choice (not temperature)
    const rgbModes = new Set(['hs', 'rgb', 'xy', 'rgbw', 'rgbww']);

    this._config.entities.forEach(id => {
      const st = this._hass?.states?.[id];
      if (!st || st.state !== 'on') return;
      if (!Array.isArray(st.attributes.rgb_color)) return;

      // Skip lights in temperature mode - their rgb_color is just the temp rendered as RGB
      const colorMode = st.attributes.color_mode;
      if (colorMode && !rgbModes.has(colorMode)) return;

      const rgb = [st.attributes.rgb_color[0], st.attributes.rgb_color[1], st.attributes.rgb_color[2]];

      // Deduplicate with tolerance against already-collected colors
      const isDupe = colors.some(c => this._rgbDistance(c.rgb, rgb) < COLOR_TOLERANCE);
      if (!isDupe) {
        const hex = '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');
        colors.push({ hex, rgb, entities: [id] });
      } else {
        // Add entity to the matching color's list
        const match = colors.find(c => this._rgbDistance(c.rgb, rgb) < COLOR_TOLERANCE);
        if (match) match.entities.push(id);
      }
    });
    return colors;
  }

  _getLiveTemperatures() {
    const TEMP_TOLERANCE = 100; // Kelvin
    const temps = [];
    this._config.entities.forEach(id => {
      const st = this._hass?.states?.[id];
      if (!st || st.state !== 'on') return;
      const colorMode = st.attributes.color_mode;
      // Only include lights actually in temperature mode
      if (colorMode !== 'color_temp') return;
      if (st.attributes.color_temp == null) return;
      const kelvin = Math.round(1000000 / st.attributes.color_temp);
      if (!Number.isFinite(kelvin)) return;

      const isDupe = temps.some(t => Math.abs(t.kelvin - kelvin) < TEMP_TOLERANCE);
      if (!isDupe) {
        temps.push({ kelvin, entities: [id] });
      } else {
        const match = temps.find(t => Math.abs(t.kelvin - kelvin) < TEMP_TOLERANCE);
        if (match) match.entities.push(id);
      }
    });
    return temps;
  }

  _replaceOrInsert(parent, selector, html, insertPosition = 'beforeend') {
    const existing = parent.querySelector(selector);
    if (html) {
      const temp = document.createElement('div');
      temp.innerHTML = html;
      const newEl = temp.firstElementChild;
      if (existing) {
        parent.replaceChild(newEl, existing);
      } else {
        parent.insertAdjacentHTML(insertPosition, html);
      }
    } else if (existing) {
      existing.remove();
    }
  }

  _refreshColorPresets() {
    if (!this.shadowRoot) return;

    const combinedHtml = this._renderPresetsContent();

    // Only replace DOM when content actually changed (prevents hover blink from DOM churn)
    if (combinedHtml !== this._lastPresetsHtml) {
      this._lastPresetsHtml = combinedHtml;
      const presetsAreas = this.shadowRoot.querySelectorAll('.presets-area');
      presetsAreas.forEach(area => { area.innerHTML = combinedHtml; });
      this._bindPresetHandlers();
      requestAnimationFrame(() => this._updateSeparatorVisibility());
    }
  }

  _highlightEntities(entityList) {
    if (!this.shadowRoot) return;
    this.shadowRoot.querySelectorAll('.light.preset-highlight').forEach(l => l.classList.remove('preset-highlight'));
    if (!entityList) return;
    const entities = typeof entityList === 'string' ? entityList.split(',') : entityList;
    entities.forEach(id => {
      const el = this.shadowRoot.querySelector(`.light[data-entity="${id}"]`);
      if (el) el.classList.add('preset-highlight');
    });
  }

  _bindPresetHighlight(el) {
    const entities = el.dataset.presetEntities;
    if (!entities) return;

    // Desktop: hover (use pointer events with pointerType check to avoid
    // synthetic mouse events fired by mobile browsers after touch taps)
    el.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') this._highlightEntities(entities); });
    el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') this._highlightEntities(null); });

    // Mobile: long-press (300ms) to highlight, release to clear
    // Uses document-level listeners so highlight clears even if DOM is replaced mid-touch
    let holdTimer = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return; // handled by pointerenter
      holdTimer = setTimeout(() => {
        holdTimer = null;
        this._highlightEntities(entities);
        if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(15);
      }, 300);
      const clearHighlight = () => {
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        this._highlightEntities(null);
        document.removeEventListener('pointerup', clearHighlight);
        document.removeEventListener('pointercancel', clearHighlight);
      };
      document.addEventListener('pointerup', clearHighlight);
      document.addEventListener('pointercancel', clearHighlight);
    });
  }

  _bindPresetHandlers() {
    if (!this.shadowRoot) return;
    this.shadowRoot.querySelectorAll('.color-preset').forEach(el => {
      if (el._presetBound) return;
      el._presetBound = true;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const rgbAttr = el.dataset.presetRgb;
        let rgb;
        if (rgbAttr) {
          rgb = rgbAttr.split(',').map(Number);
        } else {
          rgb = this._hexToRgb(el.dataset.presetColor);
        }
        if (rgb) this._applyColorWheelSelection(rgb);
      });
      this._bindPresetHighlight(el);
    });
    this.shadowRoot.querySelectorAll('.temp-preset').forEach(el => {
      if (el._presetBound) return;
      el._presetBound = true;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const kelvin = parseInt(el.dataset.presetKelvin, 10);
        if (Number.isFinite(kelvin)) this._applyTemperaturePreset(kelvin);
      });
      this._bindPresetHighlight(el);
    });
  }

  _getActivePresetColor() {
    const controlled = this._getControlledEntities();
    if (controlled.length === 0) return null;

    const rgbModes = new Set(['hs', 'rgb', 'xy', 'rgbw', 'rgbww']);
    // When nothing selected, check ALL entities for unanimity; when selected, check only selected
    const entitiesToCheck = this._selectedLights.size > 0
      ? controlled
      : this._config.entities;

    let referenceRgb = null;
    let anyRgbOn = false;

    for (const id of entitiesToCheck) {
      const st = this._hass?.states?.[id];
      if (!st || st.state !== 'on') continue;
      const colorMode = st.attributes.color_mode;
      if (colorMode && !rgbModes.has(colorMode)) continue;
      if (!Array.isArray(st.attributes.rgb_color)) continue;
      anyRgbOn = true;
      const rgb = st.attributes.rgb_color;
      if (!referenceRgb) {
        referenceRgb = rgb;
      } else if (this._rgbDistance(referenceRgb, rgb) >= 30) {
        return null;
      }
    }
    if (!anyRgbOn || !referenceRgb) return null;
    return referenceRgb;
  }

  _getActivePresetTemp() {
    const controlled = this._getControlledEntities();
    if (controlled.length === 0) return null;

    const entitiesToCheck = this._selectedLights.size > 0
      ? controlled
      : this._config.entities;

    let referenceKelvin = null;
    let anyTempOn = false;

    for (const id of entitiesToCheck) {
      const st = this._hass?.states?.[id];
      if (!st || st.state !== 'on') continue;
      if (st.attributes.color_mode !== 'color_temp') continue;
      if (st.attributes.color_temp == null) continue;
      anyTempOn = true;
      const kelvin = Math.round(1000000 / st.attributes.color_temp);
      if (referenceKelvin === null) {
        referenceKelvin = kelvin;
      } else if (Math.abs(referenceKelvin - kelvin) >= 100) {
        return null;
      }
    }
    if (!anyTempOn || referenceKelvin === null) return null;
    return referenceKelvin;
  }

  _renderColorPresets() {
    const configPresets = this._config.color_presets || [];
    const showLive = !!this._config.show_live_colors;

    // Always fetch live colors for entity matching (config presets need it too for highlight)
    const allLiveColors = this._getLiveColors();

    // Deduplicate live colors against config presets using RGB distance tolerance
    const configRgbs = configPresets.map(c => this._hexToRgb(c)).filter(Boolean);
    const filteredLive = showLive
      ? allLiveColors.filter(lc => !configRgbs.some(cr => this._rgbDistance(cr, lc.rgb) < 30))
      : [];

    if (configPresets.length === 0 && filteredLive.length === 0) return '';

    const isValidColor = (c) => /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c);
    const activeRgb = this._getActivePresetColor();

    let html = '';
    configPresets.forEach(color => {
      if (!isValidColor(color)) return;
      const rgb = this._hexToRgb(color);
      const matchingEntities = rgb ? allLiveColors
        .filter(lc => this._rgbDistance(lc.rgb, rgb) < 30)
        .flatMap(lc => lc.entities) : [];
      const entitiesAttr = matchingEntities.length ? ` data-preset-entities="${matchingEntities.join(',')}"` : '';
      const isActive = activeRgb && rgb && this._rgbDistance(rgb, activeRgb) < 30;
      html += `<div class="color-preset${isActive ? ' active' : ''}" data-preset-color="${color}"${entitiesAttr} style="--preset-color:${color};" title="${color}"></div>`;
    });
    filteredLive.forEach(lc => {
      const isActive = activeRgb && this._rgbDistance(lc.rgb, activeRgb) < 30;
      html += `<div class="color-preset${isActive ? ' active' : ''}" data-preset-color="${lc.hex}" data-preset-rgb="${lc.rgb.join(',')}" data-preset-entities="${lc.entities.join(',')}" style="--preset-color:${lc.hex};" title="${lc.hex}"></div>`;
    });

    return html;
  }

  _kelvinToRgb(kelvin) {
    // Attempt Tanner Helland approximation
    const temp = kelvin / 100;
    let r, g, b;
    if (temp <= 66) {
      r = 255;
      g = 99.4708025861 * Math.log(temp) - 161.1195681661;
      b = temp <= 19 ? 0 : 138.5177312231 * Math.log(temp - 10) - 305.0447927307;
    } else {
      r = 329.698727446 * Math.pow(temp - 60, -0.1332047592);
      g = 288.1221695283 * Math.pow(temp - 60, -0.0755148492);
      b = 255;
    }
    return [Math.max(0, Math.min(255, Math.round(r))),
            Math.max(0, Math.min(255, Math.round(g))),
            Math.max(0, Math.min(255, Math.round(b)))];
  }

  _renderTemperaturePresets() {
    if (!this._config.show_live_colors) return '';
    const temps = this._getLiveTemperatures();
    if (temps.length === 0) return '';

    const activeKelvin = this._getActivePresetTemp();

    let html = '';
    temps.forEach(t => {
      const rgb = this._kelvinToRgb(t.kelvin);
      const hex = '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');
      const entities = t.entities.join(',');
      const isActive = activeKelvin !== null && Math.abs(t.kelvin - activeKelvin) < 100;
      html += `<div class="temp-preset${isActive ? ' active' : ''}" data-preset-kelvin="${t.kelvin}" data-preset-entities="${entities}" style="--preset-color:${hex};" title="${t.kelvin}K"><span class="temp-label">${t.kelvin}K</span></div>`;
    });

    return html;
  }

  _renderPresetsContent() {
    const colorHtml = this._renderColorPresets();
    const tempHtml = this._renderTemperaturePresets();
    if (!colorHtml && !tempHtml) return '';
    let html = colorHtml || '';
    if (colorHtml && tempHtml) {
      html += '<div class="preset-separator" aria-hidden="true"></div>';
    }
    html += tempHtml || '';
    return html;
  }

  _updateSeparatorVisibility() {
    if (!this.shadowRoot) return;
    this.shadowRoot.querySelectorAll('.preset-separator').forEach(sep => {
      const prev = sep.previousElementSibling;
      const next = sep.nextElementSibling;
      if (!prev || !next) {
        sep.style.display = 'none';
        return;
      }
      // Show separator to measure layout
      sep.style.display = '';
      const prevTop = prev.getBoundingClientRect().top;
      const nextTop = next.getBoundingClientRect().top;
      // Hide if the first temp preset isn't on the same row as the last color preset
      if (Math.abs(prevTop - nextTop) > 2) {
        sep.style.display = 'none';
      }
    });
  }

  _applyColorWheelSelection(rgb) {
    const controlled = this._selectedLights.size > 0
      ? [...this._selectedLights]
      : (this._config.default_entity ? [this._config.default_entity] : []);
    if (controlled.length === 0 || !rgb) return;

    this._pendingColor = rgb;
    controlled.forEach(entity_id => {
      this._hass.callService('light', 'turn_on', {
        entity_id,
        rgb_color: this._pendingColor,
      });
    });
    this._pendingColor = null;
  }

  /** ---------- Large color wheel (long-press) ---------- */
  _openLargeColorWheel() {
    this._largeColorWheelOpen = true;
    const overlay = this._els.colorWheelOverlay;
    if (!overlay) return;

    overlay.classList.add('visible');
    this._syncOverlayState();

    // Set initial swatch color from current light state
    const swatch = this._els.colorWheelPreviewSwatch;
    if (swatch) {
      const controlled = this._getControlledEntities();
      let initColor = null;
      for (const id of controlled) {
        const st = this._hass?.states?.[id];
        if (st && st.state === 'on' && Array.isArray(st.attributes.rgb_color)) {
          initColor = st.attributes.rgb_color;
          break;
        }
      }
      if (initColor) {
        swatch.style.background = `rgb(${initColor[0]},${initColor[1]},${initColor[2]})`;
      }
    }

    // Draw the large color wheel
    const canvas = this._els.colorWheelLarge;
    if (canvas) {
      const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
      raf(() => this._drawLargeColorWheel(canvas));
    }

    this._bindLargeColorWheelEvents();
  }

  _closeLargeColorWheel() {
    this._largeColorWheelOpen = false;
    const overlay = this._els.colorWheelOverlay;
    if (!overlay) return;

    overlay.classList.remove('visible');
    this._syncOverlayState();

    // Hide magnifier
    const mag = this._els.colorWheelMagnifier;
    if (mag) mag.classList.remove('visible');
    this._largeWheelGesture = null;
  }

  _drawLargeColorWheel(canvas) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;
    const fallbackSize = 512;
    const cssSize = Math.max(rect.width, rect.height) > 0
      ? Math.min(rect.width || fallbackSize, rect.height || fallbackSize)
      : fallbackSize;

    const MAX_CANVAS_SIZE = 4096;
    let pixelSize = Math.max(1, Math.round(cssSize * dpr));
    if (!Number.isFinite(pixelSize) || pixelSize > MAX_CANVAS_SIZE || pixelSize < 1) {
      pixelSize = Math.min(fallbackSize, MAX_CANVAS_SIZE);
    }

    canvas.width = pixelSize;
    canvas.height = pixelSize;
    ctx.clearRect(0, 0, pixelSize, pixelSize);

    const radius = pixelSize / 2;
    const imageData = ctx.createImageData(pixelSize, pixelSize);
    const data = imageData.data;

    const hslToRgb = (h, s, l) => {
      if (s === 0) { const val = Math.round(l * 255); return [val, val, val]; }
      const hue2rgb = (p, q, t) => {
        if (t < 0) t += 1; if (t > 1) t -= 1;
        if (t < 1/6) return p + (q-p)*6*t;
        if (t < 1/2) return q;
        if (t < 2/3) return p + (q-p)*(2/3-t)*6;
        return p;
      };
      const q = l < 0.5 ? l*(1+s) : l+s-l*s;
      const p = 2*l-q;
      return [Math.round(hue2rgb(p,q,h+1/3)*255), Math.round(hue2rgb(p,q,h)*255), Math.round(hue2rgb(p,q,h-1/3)*255)];
    };

    for (let y = 0; y < pixelSize; y++) {
      for (let x = 0; x < pixelSize; x++) {
        const dx = x + 0.5 - radius;
        const dy = y + 0.5 - radius;
        const dist = Math.sqrt(dx*dx + dy*dy);
        if (dist > radius) continue;

        const sat = Math.min(1, dist / radius);
        const hue = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
        const lightness = 0.45 + (1-sat) * 0.35;
        const [r, g, b] = hslToRgb(hue/360, sat, lightness);

        const idx = (y * pixelSize + x) * 4;
        data[idx] = r; data[idx+1] = g; data[idx+2] = b; data[idx+3] = 255;
      }
    }

    ctx.putImageData(imageData, 0, 0);

    ctx.save();
    ctx.lineWidth = Math.max(1, 1.5 * dpr);
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.beginPath();
    ctx.arc(radius, radius, radius - ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  _getLargeWheelColorAtEvent(e) {
    const canvas = this._els.colorWheelLarge;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const imageData = ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1);
    const [r, g, b, a] = imageData.data;
    if (a === 0) return null;
    return [r, g, b];
  }

  _updateMagnifier(e) {
    const canvas = this._els.colorWheelLarge;
    const magnifier = this._els.colorWheelMagnifier;
    const magCanvas = this._els.colorWheelMagnifierCanvas;
    if (!canvas || !magnifier || !magCanvas) return;

    const rect = canvas.getBoundingClientRect();
    const canvasX = (e.clientX - rect.left) * (canvas.width / rect.width);
    const canvasY = (e.clientY - rect.top) * (canvas.height / rect.height);

    // Position magnifier above the touch/pointer point
    const magSize = 110;
    const offset = 80;
    let magX = e.clientX - magSize / 2;
    let magY = e.clientY - magSize - offset;

    // Keep on screen - flip below if too high
    if (magY < 8) magY = e.clientY + offset / 2;
    if (magX < 8) magX = 8;
    if (magX + magSize > window.innerWidth - 8) magX = window.innerWidth - magSize - 8;

    magnifier.style.left = magX + 'px';
    magnifier.style.top = magY + 'px';
    magnifier.classList.add('visible');

    // Draw zoomed view on magnifier canvas
    const magCtx = magCanvas.getContext('2d');
    if (!magCtx) return;

    const zoom = 6;
    const srcSize = magCanvas.width / zoom;
    const sx = canvasX - srcSize / 2;
    const sy = canvasY - srcSize / 2;

    magCtx.clearRect(0, 0, magCanvas.width, magCanvas.height);
    magCtx.imageSmoothingEnabled = false;

    // Clip to circle
    magCtx.save();
    magCtx.beginPath();
    magCtx.arc(magCanvas.width / 2, magCanvas.height / 2, magCanvas.width / 2, 0, Math.PI * 2);
    magCtx.clip();

    magCtx.drawImage(canvas, sx, sy, srcSize, srcSize, 0, 0, magCanvas.width, magCanvas.height);
    magCtx.restore();

    // Draw crosshair
    const cx = magCanvas.width / 2;
    const cy = magCanvas.height / 2;
    magCtx.save();
    magCtx.strokeStyle = 'rgba(255,255,255,0.85)';
    magCtx.lineWidth = 1.5;

    // Horizontal arms
    magCtx.beginPath();
    magCtx.moveTo(cx - 14, cy); magCtx.lineTo(cx - 5, cy);
    magCtx.moveTo(cx + 5, cy); magCtx.lineTo(cx + 14, cy);
    magCtx.stroke();

    // Vertical arms
    magCtx.beginPath();
    magCtx.moveTo(cx, cy - 14); magCtx.lineTo(cx, cy - 5);
    magCtx.moveTo(cx, cy + 5); magCtx.lineTo(cx, cy + 14);
    magCtx.stroke();

    // Center dot
    magCtx.fillStyle = 'rgba(255,255,255,0.95)';
    magCtx.beginPath();
    magCtx.arc(cx, cy, 2, 0, Math.PI * 2);
    magCtx.fill();

    // Dark outline for visibility on bright colors
    magCtx.strokeStyle = 'rgba(0,0,0,0.4)';
    magCtx.lineWidth = 0.75;
    magCtx.beginPath();
    magCtx.moveTo(cx - 14, cy); magCtx.lineTo(cx - 5, cy);
    magCtx.moveTo(cx + 5, cy); magCtx.lineTo(cx + 14, cy);
    magCtx.moveTo(cx, cy - 14); magCtx.lineTo(cx, cy - 5);
    magCtx.moveTo(cx, cy + 5); magCtx.lineTo(cx, cy + 14);
    magCtx.stroke();

    magCtx.restore();

    // Update magnifier border color to match selected color
    const color = this._getLargeWheelColorAtEvent(e);
    if (color) {
      magnifier.style.borderColor = `rgb(${color[0]},${color[1]},${color[2]})`;
    }
  }

  _bindLargeColorWheelEvents() {
    const canvas = this._els.colorWheelLarge;
    const overlay = this._els.colorWheelOverlay;
    const doneBtn = this.shadowRoot?.getElementById('colorWheelDoneBtn');
    const swatch = this._els.colorWheelPreviewSwatch;

    if (!canvas) return;

    // Avoid double-binding
    if (canvas._largeBound) return;
    canvas._largeBound = true;

    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.target.setPointerCapture?.(e.pointerId);

      const color = this._getLargeWheelColorAtEvent(e);
      this._largeWheelGesture = { pointerId: e.pointerId, pendingColor: color };

      // Only update swatch preview — don't send to lights yet
      if (color && swatch) {
        swatch.style.background = `rgb(${color[0]},${color[1]},${color[2]})`;
        swatch.style.borderColor = `rgba(255,255,255,0.5)`;
      }
      this._updateMagnifier(e);
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!this._largeWheelGesture || this._largeWheelGesture.pointerId !== e.pointerId) return;
      e.preventDefault();

      const color = this._getLargeWheelColorAtEvent(e);
      if (color) {
        this._largeWheelGesture.pendingColor = color;
        // Only update swatch preview — don't send to lights during drag
        if (swatch) swatch.style.background = `rgb(${color[0]},${color[1]},${color[2]})`;
      }
      this._updateMagnifier(e);
    });

    canvas.addEventListener('pointerup', (e) => {
      e.target.releasePointerCapture?.(e.pointerId);

      // Apply the final selected color to lights only if pointer ended inside the wheel
      const gesture = this._largeWheelGesture;
      this._largeWheelGesture = null;
      if (gesture && gesture.pendingColor) {
        const color = this._getLargeWheelColorAtEvent(e);
        if (color) {
          this._applyColorWheelSelection(color);
          if (swatch) swatch.style.background = `rgb(${color[0]},${color[1]},${color[2]})`;
        }
      }

      // Hide magnifier
      const mag = this._els.colorWheelMagnifier;
      if (mag) mag.classList.remove('visible');
    });

    canvas.addEventListener('pointercancel', (e) => {
      e.target.releasePointerCapture?.(e.pointerId);
      this._largeWheelGesture = null;

      const mag = this._els.colorWheelMagnifier;
      if (mag) mag.classList.remove('visible');
    });

    // Close on backdrop click
    if (overlay) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) this._closeLargeColorWheel();
      });
    }

    // Done button
    if (doneBtn) {
      doneBtn.addEventListener('click', () => this._closeLargeColorWheel());
    }
  }

  _applyTemperaturePreset(kelvin) {
    const controlled = this._selectedLights.size > 0
      ? [...this._selectedLights]
      : (this._config.default_entity ? [this._config.default_entity] : []);
    if (controlled.length === 0 || !Number.isFinite(kelvin)) return;

    const mireds = Math.round(1000000 / kelvin);
    controlled.forEach(entity_id => {
      this._hass.callService('light', 'turn_on', { entity_id, color_temp: mireds });
    });

    // Update slider to reflect the new temp
    if (this._els.temperatureSlider) {
      this._els.temperatureSlider.value = String(kelvin);
      this._updateSliderVisual(this._els.temperatureSlider);
    }
    if (this._els.temperatureValue) {
      this._els.temperatureValue.textContent = `${kelvin}K`;
    }
  }

  _handleBrightnessInput(e) {
    const val = parseInt(e.target.value, 10);
    if (e.target.dataset.ignoreChange === 'true') {
      e.target.value = e.target.dataset.startValue || e.target.value;
      this._updateSliderVisual(e.target);
      return;
    }
    if (this._els.brightnessValue) this._els.brightnessValue.textContent = `${Math.round((val / 255) * 100)}%`;
    this._updateSliderVisual(this._els.brightnessSlider);
    this._pendingBrightness = val;
  }
  _handleBrightnessChange() {
    if (this._pendingBrightness == null) return;
    if (this._els.brightnessSlider && this._els.brightnessSlider.dataset.ignoreChange === 'true') {
      this._pendingBrightness = null;
      return;
    }
    const controlled = this._selectedLights.size > 0
      ? [...this._selectedLights]
      : (this._config.default_entity ? [this._config.default_entity] : []);
    if (controlled.length === 0) { this._pendingBrightness = null; return; }

    const b = this._pendingBrightness;
    controlled.forEach(entity_id => {
      this._hass.callService('light', 'turn_on', { entity_id, brightness: b });
    });
    this._pendingBrightness = null;
  }

  _handleTemperatureInput(e) {
    const k = parseInt(e.target.value, 10);
    if (e.target.dataset.ignoreChange === 'true') {
      e.target.value = e.target.dataset.startValue || e.target.value;
      this._updateSliderVisual(e.target);
      return;
    }
    if (this._els.temperatureValue) this._els.temperatureValue.textContent = `${k}K`;
    this._updateSliderVisual(this._els.temperatureSlider);
    this._pendingTemperature = k;
  }
  _handleTemperatureChange() {
    if (this._pendingTemperature == null) return;
    if (this._els.temperatureSlider && this._els.temperatureSlider.dataset.ignoreChange === 'true') {
      this._pendingTemperature = null;
      return;
    }
    const controlled = this._selectedLights.size > 0
      ? [...this._selectedLights]
      : (this._config.default_entity ? [this._config.default_entity] : []);
    if (controlled.length === 0) { this._pendingTemperature = null; return; }

    const mireds = Math.round(1000000 / this._pendingTemperature);
    controlled.forEach(entity_id => {
      this._hass.callService('light', 'turn_on', { entity_id, color_temp: mireds });
    });
    this._pendingTemperature = null;
  }

  _requestColorWheelDraw(force = false) {
    if (this._colorWheelFrame) return;
    const schedule = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb) => setTimeout(cb, 16);
    const cancel = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout;
    this._colorWheelCancel = cancel;
    this._colorWheelFrame = schedule(() => {
      this._colorWheelFrame = null;
      this.drawColorWheel(force);
    });
  }

  drawColorWheel(force = false) {
    const canvas = this._els.colorWheel;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Skip drawing if canvas is not visible (e.g., display: none)
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      return;
    }

    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;
    const fallbackSize = Number(canvas.getAttribute('width')) || 256;
    const cssSize = Math.max(rect.width, rect.height) > 0
      ? Math.min(rect.width || fallbackSize, rect.height || fallbackSize)
      : fallbackSize;

    // Ensure pixelSize is within safe bounds to prevent OOM
    // Max dimension: 4096px (reasonable for canvas operations)
    const MAX_CANVAS_SIZE = 4096;
    let pixelSize = Math.max(1, Math.round(cssSize * dpr));

    // Validate pixelSize is finite and within safe range
    if (!Number.isFinite(pixelSize) || pixelSize > MAX_CANVAS_SIZE || pixelSize < 1) {
      console.warn(`Invalid canvas dimensions calculated: ${pixelSize}. Using fallback.`);
      pixelSize = Math.min(fallbackSize, MAX_CANVAS_SIZE);
    }

    if (canvas.width !== pixelSize || canvas.height !== pixelSize) {
      canvas.width = pixelSize;
      canvas.height = pixelSize;
    } else if (!force && this._colorWheelLastSize && this._colorWheelLastSize.pixelSize === pixelSize && this._colorWheelLastSize.dpr === dpr) {
      return;
    }

    this._colorWheelLastSize = { pixelSize, dpr };

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const radius = pixelSize / 2;
    const imageData = ctx.createImageData(pixelSize, pixelSize);
    const data = imageData.data;

    const hslToRgb = (h, s, l) => {
      if (s === 0) {
        const val = Math.round(l * 255);
        return [val, val, val];
      }
      const hue2rgb = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      const r = hue2rgb(p, q, h + 1 / 3);
      const g = hue2rgb(p, q, h);
      const b = hue2rgb(p, q, h - 1 / 3);
      return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
    };

    for (let y = 0; y < pixelSize; y += 1) {
      for (let x = 0; x < pixelSize; x += 1) {
        const dx = x + 0.5 - radius;
        const dy = y + 0.5 - radius;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > radius) continue;

        const sat = Math.min(1, dist / radius);
        const hue = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
        const lightness = 0.45 + (1 - sat) * 0.35;
        const [r, g, b] = hslToRgb(hue / 360, sat, lightness);

        const idx = (y * pixelSize + x) * 4;
        data[idx] = r;
        data[idx + 1] = g;
        data[idx + 2] = b;
        data[idx + 3] = 255;
      }
    }

    ctx.putImageData(imageData, 0, 0);

    ctx.save();
    ctx.lineWidth = Math.max(1, 1.5 * dpr);
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.beginPath();
    ctx.arc(radius, radius, radius - ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /** ---------- Light updates ---------- */
  updateLights() {
    if (!this._hass) return;
    const lights = this.shadowRoot.querySelectorAll('.light');
    lights.forEach(light => {
      const id = light.dataset.entity;
      const st = this._hass.states[id];
      if (!st) return;

      const [domain] = id.split('.');
      const isOn = st.state === 'on';
      const isScene = domain === 'scene';

      const color = this._resolveEntityColor(id, isOn, st.attributes);

      // Determine if this light is in icon-only mode
      const isIconOnly = this._config.icon_only_overrides[id] !== undefined
        ? this._config.icon_only_overrides[id]
        : this._config.icon_only_mode;

      if (isIconOnly) {
        // For icon-only mode, use CSS variable for color
        light.style.background = 'transparent';
        if (color !== 'transparent') {
          light.style.setProperty('--light-color', color);
        } else {
          light.style.removeProperty('--light-color');
        }
      } else {
        // Standard mode: set background directly
        light.style.removeProperty('--light-color');
        if (color !== 'transparent') {
          light.style.background = color;
        } else {
          light.style.background = ''; // Fallback to CSS
        }
      }

      light.classList.toggle('off', !isOn && !isScene);
      light.classList.toggle('on', isOn || isScene);

      // Ensure selected styling matches current selection set
      const selected = this._selectedLights.has(id);
      light.classList.toggle('selected', selected);
    });

    // Toggle has-selection class on canvas for unselected dimming
    if (this._els.canvas) {
      this._els.canvas.classList.toggle('has-selection', this._selectedLights.size > 0);
    }

    // Update controls to reflect averaged state
    const shouldShowControls = this._config.always_show_controls || this._selectedLights.size > 0 || this._config.default_entity;
    if (shouldShowControls) {
      const controlContext = this._getControlContext();
      this._updateControlValues(controlContext);
    }
    // Show/hide floating controls if used
    if (this._els.controlsFloating) {
      this._els.controlsFloating.classList.toggle('visible', shouldShowControls);
    }
    // Show/hide below controls if used
    if (this._els.controlsBelow) {
      this._els.controlsBelow.classList.toggle('visible', shouldShowControls);
    }
    if ((this._config.always_show_controls || this._selectedLights.size > 0 || this._config.default_entity) && this._els.colorWheel) {
      this._requestColorWheelDraw();
    }
    this._refreshColorPresets();
    this._refreshEntityIcons();
  }

  /** ---------- YAML generation ---------- */
  _generateYAML() {
    const indent = '  ';
    const yamlLines = [`type: custom:spatial-light-color-card`];

    if (this._config.title) yamlLines.push(`title: ${this._config.title}`);
    yamlLines.push(`canvas_height: ${this._config.canvas_height}`);
    yamlLines.push(`grid_size: ${this._config.grid_size}`);
    if (this._config.label_mode) yamlLines.push(`label_mode: ${this._config.label_mode}`);
    yamlLines.push(`always_show_controls: ${!!this._config.always_show_controls}`);
    yamlLines.push(`controls_below: ${!!this._config.controls_below}`);
    yamlLines.push(`show_entity_icons: ${!!this._config.show_entity_icons}`);
    yamlLines.push(`switch_single_tap: ${!!this._config.switch_single_tap}`);
    yamlLines.push(`icon_style: ${this._config.icon_style}`);
    if (this._config.default_entity) yamlLines.push(`default_entity: ${this._config.default_entity}`);
    if (Number.isFinite(this._config.temperature_min)) yamlLines.push(`temperature_min: ${this._config.temperature_min}`);
    if (Number.isFinite(this._config.temperature_max)) yamlLines.push(`temperature_max: ${this._config.temperature_max}`);

    // Light size settings
    if (this._config.light_size !== 56) yamlLines.push(`light_size: ${this._config.light_size}`);
    if (this._config.icon_only_mode) yamlLines.push(`icon_only_mode: true`);

    // Per-entity size overrides
    if (this._config.size_overrides && Object.keys(this._config.size_overrides).length) {
      yamlLines.push('size_overrides:');
      Object.entries(this._config.size_overrides).forEach(([entity, size]) => {
        yamlLines.push(`${indent}${entity}: ${size}`);
      });
    }

    // Per-entity icon-only overrides
    if (this._config.icon_only_overrides && Object.keys(this._config.icon_only_overrides).length) {
      yamlLines.push('icon_only_overrides:');
      Object.entries(this._config.icon_only_overrides).forEach(([entity, val]) => {
        yamlLines.push(`${indent}${entity}: ${val}`);
      });
    }

    // Colors
    if (this._config.switch_on_color !== '#ffa500') yamlLines.push(`switch_on_color: "${this._config.switch_on_color}"`);
    if (this._config.switch_off_color !== '#2a2a2a') yamlLines.push(`switch_off_color: "${this._config.switch_off_color}"`);
    if (this._config.scene_color !== '#6366f1') yamlLines.push(`scene_color: "${this._config.scene_color}"`);
    if (this._config.binary_sensor_on_color !== '#4caf50') yamlLines.push(`binary_sensor_on_color: "${this._config.binary_sensor_on_color}"`);
    if (this._config.binary_sensor_off_color !== '#2a2a2a') yamlLines.push(`binary_sensor_off_color: "${this._config.binary_sensor_off_color}"`);

    if (this._config.color_overrides && Object.keys(this._config.color_overrides).length) {
      yamlLines.push('color_overrides:');
      Object.entries(this._config.color_overrides).forEach(([entity, val]) => {
        if (typeof val === 'string') {
          yamlLines.push(`${indent}${entity}: "${val}"`);
        } else {
          yamlLines.push(`${indent}${entity}:`);
          if (val.state_on) yamlLines.push(`${indent}${indent}state_on: "${val.state_on}"`);
          if (val.state_off) yamlLines.push(`${indent}${indent}state_off: "${val.state_off}"`);
        }
      });
    }

    if (this._config.color_presets && this._config.color_presets.length) {
      yamlLines.push('color_presets:');
      this._config.color_presets.forEach(color => {
        yamlLines.push(`${indent}- "${color}"`);
      });
    }
    if (this._config.show_live_colors) yamlLines.push(`show_live_colors: true`);

    if (this._config.label_overrides && Object.keys(this._config.label_overrides).length) {
      yamlLines.push('label_overrides:');
      Object.entries(this._config.label_overrides).forEach(([entity, label]) => {
        yamlLines.push(`${indent}${entity}: ${label}`);
      });
    }

    if (this._config.background_image) {
      const bg = this._config.background_image;
      if (typeof bg === 'string') {
        yamlLines.push(`background_image: ${bg}`);
      } else {
        yamlLines.push('background_image:');
        if (bg.url) yamlLines.push(`${indent}url: ${bg.url}`);
        if (bg.size) yamlLines.push(`${indent}size: ${bg.size}`);
        if (bg.position) yamlLines.push(`${indent}position: ${bg.position}`);
        if (bg.repeat) yamlLines.push(`${indent}repeat: ${bg.repeat}`);
        if (bg.blend_mode) yamlLines.push(`${indent}blend_mode: ${bg.blend_mode}`);
        if (bg.opacity !== undefined) yamlLines.push(`${indent}opacity: ${bg.opacity}`);
      }
    }

    yamlLines.push('entities:');
    this._config.entities.forEach(ent => { yamlLines.push(`${indent}- ${ent}`); });

    yamlLines.push('positions:');
    Object.entries(this._config.positions).forEach(([ent, pos]) => {
      yamlLines.push(`${indent}${ent}:`);
      yamlLines.push(`${indent}${indent}x: ${Number(pos.x.toFixed ? pos.x.toFixed(2) : pos.x)}`);
      yamlLines.push(`${indent}${indent}y: ${Number(pos.y.toFixed ? pos.y.toFixed(2) : pos.y)}`);
    });

    return `${yamlLines.join('\n')}\n`;
  }

  getCardSize() { return 8; }
  static getConfigElement() {
    return document.createElement('spatial-light-color-card-editor');
  }
  static getStubConfig() {
    return {
      entities: [], positions: {}, title: '',
      canvas_height: 450, grid_size: 25, label_mode: 'smart',
      always_show_controls: false, controls_below: true,
      default_entity: null, show_entity_icons: true, icon_style: 'mdi',
      light_size: 56, icon_only_mode: false, size_overrides: {}, icon_only_overrides: {},
      icon_rotation: 0, icon_rotation_overrides: {}, icon_mirror: 'none', icon_mirror_overrides: {},
      switch_on_color: '#ffa500', switch_off_color: '#2a2a2a', scene_color: '#6366f1',
      binary_sensor_on_color: '#4caf50', binary_sensor_off_color: '#2a2a2a',
      color_presets: [],
      show_live_colors: false,
    };
  }
}

/** ---------- Visual Card Editor ---------- */
class SpatialLightColorCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
    this._hass = null;
    this._configFromEditor = false;
    this._editorId = Math.random().toString(36).substr(2, 9);
    this._expandedEntity = null;
    this._boundPositionHandler = null;
    this._haElementsLoaded = false;
    this._positionHistory = [];
    this._positionRedoStack = [];
    this._boundEditorKeyDown = null;
  }

  async connectedCallback() {
    this._boundPositionHandler = (e) => {
      if (e.detail && e.detail.editorId === this._editorId && e.detail.positions) {
        this._pushPositionHistory();
        if (!this._config.positions) this._config.positions = {};
        this._config.positions = e.detail.positions;
        this._fireConfigChanged();
      }
    };
    window.addEventListener('spatial-card-positions-changed', this._boundPositionHandler);

    this._boundEditorKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        if (this._positionHistory.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          this._undoPositions();
        }
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'Z' && e.shiftKey) || (e.key === 'z' && e.shiftKey))) {
        if (this._positionRedoStack.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          this._redoPositions();
        }
      }
    };
    // Use capture so we intercept before the card's own handler
    window.addEventListener('keydown', this._boundEditorKeyDown, true);

    // Force HA to load lazy custom elements (ha-entity-picker, ha-switch, etc.)
    if (!this._haElementsLoaded) {
      await this._loadHAElements();
      this._haElementsLoaded = true;
      // Re-render now that elements are available
      if (this._config.entities) {
        this._render();
      }
    }
  }

  async _loadHAElements() {
    // ha-entity-picker and ha-switch are lazy-loaded by HA.
    // We must trigger their loading before we can use them.
    if (!customElements.get('ha-entity-picker')) {
      // Method 1: loadCardHelpers (most reliable)
      try {
        if (window.loadCardHelpers) {
          const helpers = await window.loadCardHelpers();
          if (helpers) {
            // Creating an entities card element forces HA to load ha-entity-picker
            const card = await helpers.createCardElement({ type: 'entities', entities: [] });
            if (card) {
              // Trigger the card to load its editor elements
              await card.constructor?.getConfigElement?.();
            }
          }
        }
      } catch (_) { /* ignore */ }

      // Method 2: Wait for custom element to be defined (with timeout)
      if (!customElements.get('ha-entity-picker')) {
        try {
          await Promise.race([
            customElements.whenDefined('ha-entity-picker'),
            new Promise(resolve => setTimeout(resolve, 3000)),
          ]);
        } catch (_) { /* ignore */ }
      }
    }

    // ha-picture-upload is lazy-loaded. Trigger loading by briefly mounting
    // a ha-form with a media selector, which imports ha-picture-upload as a dependency.
    if (!customElements.get('ha-picture-upload')) {
      try {
        const form = document.createElement('ha-form');
        form.schema = [{ name: '_', selector: { media: { image_upload: true } } }];
        form.data = {};
        form.computeLabel = () => '';
        if (this._hass) form.hass = this._hass;
        form.style.display = 'none';
        this.shadowRoot.appendChild(form);
        await Promise.race([
          customElements.whenDefined('ha-picture-upload'),
          new Promise(resolve => setTimeout(resolve, 5000)),
        ]);
        form.remove();
      } catch (_) { /* ignore */ }
    }
  }

  disconnectedCallback() {
    if (this._boundPositionHandler) {
      window.removeEventListener('spatial-card-positions-changed', this._boundPositionHandler);
      this._boundPositionHandler = null;
    }
    if (this._boundEditorKeyDown) {
      window.removeEventListener('keydown', this._boundEditorKeyDown, true);
      this._boundEditorKeyDown = null;
    }
    this._positionHistory = [];
    this._positionRedoStack = [];
    if (this._config._edit_positions) {
      delete this._config._edit_positions;
      delete this._config._editor_id;
      this._fireConfigChanged();
    }
  }

  set hass(hass) {
    this._hass = hass;
    this._setupEntityPickers();
  }

  setConfig(config) {
    this._config = JSON.parse(JSON.stringify(config));
    if (this._configFromEditor) {
      this._configFromEditor = false;
      return;
    }
    this._render();
  }

  _fireConfigChanged() {
    this._configFromEditor = true;
    const config = JSON.parse(JSON.stringify(this._config));
    this.dispatchEvent(new CustomEvent('config-changed', {
      detail: { config },
      bubbles: true,
      composed: true,
    }));
    requestAnimationFrame(() => { this._configFromEditor = false; });
  }

  _pushPositionHistory() {
    const snapshot = JSON.parse(JSON.stringify(this._config.positions || {}));
    // Avoid duplicate consecutive snapshots
    const last = this._positionHistory[this._positionHistory.length - 1];
    if (last && JSON.stringify(last) === JSON.stringify(snapshot)) return;
    this._positionHistory.push(snapshot);
    // New action clears redo stack
    this._positionRedoStack = [];
    // Cap history at 50 entries
    if (this._positionHistory.length > 50) this._positionHistory.shift();
    this._updateUndoRedoButtons();
  }

  _undoPositions() {
    if (this._positionHistory.length === 0) return;
    // Push current state to redo stack
    this._positionRedoStack.push(JSON.parse(JSON.stringify(this._config.positions || {})));
    this._config.positions = this._positionHistory.pop();
    this._fireConfigChanged();
    this._updateUndoRedoButtons();
  }

  _redoPositions() {
    if (this._positionRedoStack.length === 0) return;
    // Push current state to undo stack
    this._positionHistory.push(JSON.parse(JSON.stringify(this._config.positions || {})));
    this._config.positions = this._positionRedoStack.pop();
    this._fireConfigChanged();
    this._updateUndoRedoButtons();
  }

  _updateUndoRedoButtons() {
    if (!this.shadowRoot) return;
    const undoBtn = this.shadowRoot.getElementById('undoPositionsBtn');
    const redoBtn = this.shadowRoot.getElementById('redoPositionsBtn');
    if (undoBtn) undoBtn.disabled = this._positionHistory.length === 0;
    if (redoBtn) redoBtn.disabled = this._positionRedoStack.length === 0;
  }

  _setupEntityPickers() {
    if (!this._hass || !this.shadowRoot) return;
    this.shadowRoot.querySelectorAll('ha-entity-picker').forEach(picker => {
      picker.hass = this._hass;
      if (!picker.includeDomains || picker.includeDomains.length === 0) {
        picker.includeDomains = ['light', 'switch', 'scene', 'input_boolean', 'binary_sensor'];
      }
    });
    // Set default entity picker value
    const defPicker = this.shadowRoot.getElementById('cfgDefaultEntity');
    if (defPicker) {
      defPicker.value = this._config.default_entity || '';
    }
    // Set hass on background image uploader
    if (this._bgUploadEl) {
      this._bgUploadEl.hass = this._hass;
    }
  }

  _initBgUpload(bgUrl) {
    const container = this.shadowRoot?.getElementById('cfgBgImageContainer');
    if (!container) return;

    // If already created, just update value and hass
    if (this._bgUploadEl) {
      this._bgUploadEl.value = bgUrl || null;
      if (this._hass) this._bgUploadEl.hass = this._hass;
      return;
    }

    // Wait for ha-picture-upload to be defined, then create it
    const create = () => {
      if (this._bgUploadEl) return;
      const el = document.createElement('ha-picture-upload');
      el.setAttribute('select-media', '');
      el.value = bgUrl || null;
      if (this._hass) el.hass = this._hass;
      el.addEventListener('change', () => {
        const val = el.value || '';
        if (val) {
          if (this._config.background_image && typeof this._config.background_image === 'object') {
            this._config.background_image.url = val;
          } else {
            this._config.background_image = val;
          }
        } else {
          // Preserve non-URL settings (size, position, etc.) so they apply to the next picked image
          if (this._config.background_image && typeof this._config.background_image === 'object') {
            delete this._config.background_image.url;
            if (Object.keys(this._config.background_image).length === 0) {
              this._config.background_image = null;
            }
          } else {
            this._config.background_image = null;
          }
        }
        this._fireConfigChanged();
      });
      container.appendChild(el);
      this._bgUploadEl = el;
    };

    if (customElements.get('ha-picture-upload')) {
      create();
    } else {
      customElements.whenDefined('ha-picture-upload').then(create);
    }
  }

  _getEntityName(entityId) {
    if (this._hass && this._hass.states[entityId]) {
      return this._hass.states[entityId].attributes.friendly_name || entityId;
    }
    return entityId;
  }

  _getDomainIcon(entityId) {
    const domain = entityId.split('.')[0];
    const map = { light: 'mdi:lightbulb', switch: 'mdi:toggle-switch', scene: 'mdi:palette', input_boolean: 'mdi:toggle-switch-outline', binary_sensor: 'mdi:eye' };
    return map[domain] || 'mdi:help-circle';
  }

  _esc(str) {
    return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  _editorStyles() {
    return `
      :host { display: block; }
      .card-config { display: flex; flex-direction: column; gap: 16px; }
      .section {
        border: 1px solid var(--divider-color, rgba(0,0,0,0.12));
        border-radius: 8px; overflow: hidden;
      }
      .section-header {
        padding: 12px 16px; background: var(--secondary-background-color, #fafafa);
        cursor: pointer; display: flex; align-items: center;
        justify-content: space-between; user-select: none;
      }
      .section-header h3 { margin: 0; font-size: 14px; font-weight: 600; color: var(--primary-text-color, #212121); }
      .section-header .chevron {
        transition: transform 200ms ease; color: var(--secondary-text-color, #727272); font-size: 12px;
      }
      .section.collapsed .section-header .chevron { transform: rotate(-90deg); }
      .section.collapsed .section-body { display: none; }
      .section-body { padding: 12px 16px; display: flex; flex-direction: column; gap: 12px; }

      .entity-list { display: flex; flex-direction: column; gap: 4px; }
      .entity-item {
        border: 1px solid var(--divider-color, rgba(0,0,0,0.08));
        border-radius: 8px; overflow: hidden;
      }
      .entity-item.expanded { border-color: var(--primary-color, #03a9f4); }
      .entity-main {
        display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 12px;
        background: var(--secondary-background-color, #f5f5f5);
        cursor: pointer;
      }
      .entity-main ha-icon {
        color: var(--secondary-text-color, #727272); --mdc-icon-size: 20px; flex-shrink: 0;
      }
      .entity-main .entity-info { flex: 1; min-width: 0; }
      .entity-main .entity-name {
        font-size: 13px; color: var(--primary-text-color, #212121);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block;
      }
      .entity-main .entity-id {
        font-size: 10px; color: var(--secondary-text-color, #727272);
        font-family: monospace; white-space: nowrap; overflow: hidden;
        text-overflow: ellipsis; display: block;
      }
      .entity-btn {
        color: var(--secondary-text-color, #727272); cursor: pointer;
        border: none; background: none; padding: 4px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        min-width: 28px; min-height: 28px; font-size: 14px; flex-shrink: 0;
      }
      .entity-btn:hover { background: rgba(0,0,0,0.06); }
      .entity-btn.remove:hover { color: var(--error-color, #db4437); background: rgba(219,68,55,0.1); }
      .entity-btn.expand { font-size: 10px; transition: transform 200ms; }
      .entity-item.expanded .entity-btn.expand { transform: rotate(180deg); }

      .entity-overrides {
        padding: 10px 12px; display: none; flex-direction: column; gap: 10px;
        border-top: 1px solid var(--divider-color, rgba(0,0,0,0.08));
        background: var(--card-background-color, #fff);
      }
      .entity-item.expanded .entity-overrides { display: flex; }
      .entity-overrides .override-row {
        display: flex; align-items: center; gap: 8px;
      }
      .entity-overrides .override-row label {
        font-size: 12px; color: var(--secondary-text-color, #727272);
        min-width: 70px; flex-shrink: 0;
      }
      .entity-overrides .override-row input {
        flex: 1; padding: 5px 8px; border: 1px solid var(--divider-color, rgba(0,0,0,0.12));
        border-radius: 4px; font-size: 13px; color: var(--primary-text-color, #212121);
        background: var(--card-background-color, #fff); box-sizing: border-box; outline: none;
        min-width: 0;
      }
      .entity-overrides .override-row input:focus { border-color: var(--primary-color, #03a9f4); }
      .entity-overrides .override-row select {
        flex: 1; padding: 5px 8px; border: 1px solid var(--divider-color, rgba(0,0,0,0.12));
        border-radius: 4px; font-size: 13px; color: var(--primary-text-color, #212121);
        background: var(--card-background-color, #fff); box-sizing: border-box; outline: none;
        min-width: 0;
      }
      .entity-overrides .override-row select:focus { border-color: var(--primary-color, #03a9f4); }
      .entity-overrides .override-switch {
        display: flex; align-items: center; justify-content: space-between; gap: 8px;
      }
      .entity-overrides .override-switch label { min-width: unset; flex: 1; }
      .color-preview {
        width: 24px; height: 24px; border-radius: 4px; flex-shrink: 0;
        border: 1px solid var(--divider-color, rgba(0,0,0,0.12));
      }

      .add-entity-row { padding-top: 4px; }
      .add-entity-row ha-entity-picker {
        width: 100%; display: block;
      }
      .empty-entities {
        text-align: center; padding: 20px 16px;
        color: var(--secondary-text-color, #727272); font-size: 13px; line-height: 1.5;
      }

      .option-row {
        display: flex; align-items: center; justify-content: space-between;
        min-height: 40px; gap: 16px;
      }
      .option-row .label { font-size: 14px; color: var(--primary-text-color, #212121); flex: 1; }
      .option-row .sublabel { font-size: 12px; color: var(--secondary-text-color, #727272); margin-top: 2px; }
      .input-row { display: flex; flex-direction: column; gap: 4px; }
      .input-row label { font-size: 12px; font-weight: 500; color: var(--secondary-text-color, #727272); }
      .input-row input[type="number"],
      .input-row input[type="text"],
      .input-row input[type="url"],
      .input-row input[type="color"] {
        width: 100%; padding: 8px 12px;
        border: 1px solid var(--divider-color, rgba(0,0,0,0.12));
        border-radius: 6px; font-size: 14px; color: var(--primary-text-color, #212121);
        background: var(--card-background-color, #fff); box-sizing: border-box;
        outline: none; transition: border-color 150ms ease;
      }
      .input-row input:focus { border-color: var(--primary-color, #03a9f4); }
      .input-row select {
        width: 100%; padding: 8px 12px;
        border: 1px solid var(--divider-color, rgba(0,0,0,0.12));
        border-radius: 6px; font-size: 14px; color: var(--primary-text-color, #212121);
        background: var(--card-background-color, #fff); box-sizing: border-box;
        outline: none; cursor: pointer;
      }
      .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      .three-col { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
      .slider-row { display: flex; align-items: center; gap: 12px; }
      .slider-row input[type="range"] {
        flex: 1; -webkit-appearance: none; appearance: none; height: 6px;
        background: var(--divider-color, rgba(0,0,0,0.12)); border-radius: 3px; cursor: pointer;
      }
      .slider-row input[type="range"]::-webkit-slider-thumb {
        -webkit-appearance: none; width: 18px; height: 18px; border-radius: 50%;
        background: var(--primary-color, #03a9f4); cursor: pointer;
      }
      .slider-row input[type="range"]::-moz-range-thumb {
        width: 18px; height: 18px; border-radius: 50%;
        background: var(--primary-color, #03a9f4); cursor: pointer; border: none;
      }
      .slider-value {
        font-size: 13px; color: var(--secondary-text-color, #727272);
        min-width: 44px; text-align: right; font-variant-numeric: tabular-nums;
      }
      ha-switch { --mdc-theme-secondary: var(--primary-color, #03a9f4); }
      #cfgBgImageContainer ha-picture-upload { display: block; width: 100%; }

      .edit-positions-banner {
        padding: 10px 14px; border-radius: 8px;
        background: color-mix(in srgb, var(--primary-color, #03a9f4) 12%, transparent);
        border: 1px solid color-mix(in srgb, var(--primary-color, #03a9f4) 30%, transparent);
        font-size: 12px; color: var(--primary-text-color, #212121); line-height: 1.5;
      }

      .action-btn {
        padding: 8px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500;
        border: 1px solid var(--divider-color, rgba(0,0,0,0.12));
        background: var(--secondary-background-color, #fafafa);
        color: var(--primary-text-color, #212121);
        transition: background 150ms ease;
      }
      .action-btn:hover { background: var(--divider-color, rgba(0,0,0,0.06)); }
      .action-btn:disabled { opacity: 0.4; cursor: default; pointer-events: none; }

      .undo-redo-row { display: flex; gap: 8px; }
      .undo-redo-row .action-btn { flex: 1; text-align: center; }

      .color-input-row {
        display: flex; align-items: center; gap: 8px;
      }
      .color-input-row input[type="color"] {
        width: 36px; height: 36px; padding: 2px; border-radius: 6px; cursor: pointer;
        flex-shrink: 0;
      }
      .color-input-row input[type="text"] {
        flex: 1; padding: 8px 12px;
        border: 1px solid var(--divider-color, rgba(0,0,0,0.12));
        border-radius: 6px; font-size: 14px; color: var(--primary-text-color, #212121);
        background: var(--card-background-color, #fff); box-sizing: border-box;
        outline: none; font-family: monospace;
      }

      .color-presets-list {
        display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
      }
      .color-preset-chip {
        width: 28px; height: 28px; border-radius: 6px; cursor: pointer;
        border: 1px solid var(--divider-color, rgba(0,0,0,0.12));
        position: relative; display: flex; align-items: center; justify-content: center;
      }
      .color-preset-chip:hover { opacity: 0.8; }
      .color-preset-chip .remove-preset {
        display: none; position: absolute; inset: 0; background: rgba(0,0,0,0.5);
        border-radius: 6px; color: white; font-size: 14px;
        align-items: center; justify-content: center;
      }
      .color-preset-chip:hover .remove-preset { display: flex; }
      .add-preset-btn {
        width: 28px; height: 28px; border-radius: 6px; cursor: pointer;
        border: 1px dashed var(--divider-color, rgba(0,0,0,0.3));
        background: transparent; color: var(--secondary-text-color, #727272);
        display: flex; align-items: center; justify-content: center; font-size: 16px;
      }
      .add-preset-btn:hover { border-color: var(--primary-color, #03a9f4); color: var(--primary-color, #03a9f4); }
    `;
  }

  _renderEntityItem(entity, index) {
    const isExpanded = this._expandedEntity === entity;
    const name = this._getEntityName(entity);
    const icon = this._getDomainIcon(entity);

    const labelOverride = (this._config.label_overrides && this._config.label_overrides[entity]) || '';
    const sizeOverride = (this._config.size_overrides && this._config.size_overrides[entity]) || '';
    const colorOverride = this._config.color_overrides && this._config.color_overrides[entity];
    const colorOn = typeof colorOverride === 'string' ? colorOverride : (colorOverride && (colorOverride.state_on || colorOverride.on) ? (colorOverride.state_on || colorOverride.on) : '');
    const colorOff = typeof colorOverride === 'object' && colorOverride ? (colorOverride.state_off || colorOverride.off || '') : '';
    const iconOnlyOverride = this._config.icon_only_overrides && this._config.icon_only_overrides[entity];
    const iconOnlyChecked = iconOnlyOverride !== undefined ? iconOnlyOverride : false;
    const hasIconOnlyOverride = iconOnlyOverride !== undefined;
    const rotationOverride = (this._config.icon_rotation_overrides && this._config.icon_rotation_overrides[entity] !== undefined) ? this._config.icon_rotation_overrides[entity] : '';
    const mirrorOverride = (this._config.icon_mirror_overrides && this._config.icon_mirror_overrides[entity]) || '';

    return `
      <div class="entity-item ${isExpanded ? 'expanded' : ''}" data-entity="${entity}" data-index="${index}">
        <div class="entity-main">
          <ha-icon icon="${icon}"></ha-icon>
          <div class="entity-info">
            <span class="entity-name" data-entity="${entity}">${this._esc(name)}</span>
            <span class="entity-id">${entity}</span>
          </div>
          <button class="entity-btn expand" data-index="${index}" title="Entity settings">&#9660;</button>
          <button class="entity-btn remove" data-index="${index}" title="Remove">&times;</button>
        </div>
        <div class="entity-overrides">
          <div class="override-row">
            <label>Label</label>
            <input type="text" data-entity="${entity}" data-key="label" value="${this._esc(labelOverride)}" placeholder="Auto">
          </div>
          <div class="override-row">
            <label>Size (px)</label>
            <input type="number" data-entity="${entity}" data-key="size" value="${sizeOverride}" placeholder="${this._config.light_size || 56}" min="16" max="200">
          </div>
          <div class="override-row">
            <label>Color (on)</label>
            <input type="text" data-entity="${entity}" data-key="color_on" value="${this._esc(colorOn)}" placeholder="#hex or empty">
            <div class="color-preview" data-entity="${entity}" data-state="on" style="background:${colorOn || 'transparent'};"></div>
          </div>
          <div class="override-row">
            <label>Color (off)</label>
            <input type="text" data-entity="${entity}" data-key="color_off" value="${this._esc(colorOff)}" placeholder="#hex or empty">
            <div class="color-preview" data-entity="${entity}" data-state="off" style="background:${colorOff || 'transparent'};"></div>
          </div>
          <div class="override-row">
            <label>Rotation (°)</label>
            <input type="number" data-entity="${entity}" data-key="icon_rotation" value="${rotationOverride}" placeholder="Global (${this._config.icon_rotation || 0})" min="0" max="360" step="1">
          </div>
          <div class="override-row">
            <label>Mirror</label>
            <select data-entity="${entity}" data-key="icon_mirror">
              <option value=""${mirrorOverride === '' ? ' selected' : ''}>Global (${this._config.icon_mirror || 'none'})</option>
              <option value="none"${mirrorOverride === 'none' ? ' selected' : ''}>None</option>
              <option value="horizontal"${mirrorOverride === 'horizontal' ? ' selected' : ''}>Horizontal</option>
              <option value="vertical"${mirrorOverride === 'vertical' ? ' selected' : ''}>Vertical</option>
              <option value="both"${mirrorOverride === 'both' ? ' selected' : ''}>Both</option>
            </select>
          </div>
          <div class="override-switch">
            <label>Icon-only override</label>
            <ha-switch data-entity="${entity}" data-key="iconOnly" ${hasIconOnlyOverride && iconOnlyChecked ? 'checked' : ''}></ha-switch>
          </div>
        </div>
      </div>
    `;
  }

  _render() {
    const config = this._config;
    const entities = config.entities || [];
    const editPositions = !!config._edit_positions;
    const presets = Array.isArray(config.color_presets) ? config.color_presets : [];

    // Clear reference since innerHTML will destroy it
    this._bgUploadEl = null;

    this.shadowRoot.innerHTML = `
      <style>${this._editorStyles()}</style>
      <div class="card-config">

        <!-- Entities Section -->
        <div class="section" id="section-entities">
          <div class="section-header" data-section="entities">
            <h3>Entities</h3>
            <span class="chevron">&#9660;</span>
          </div>
          <div class="section-body">
            ${entities.length === 0
              ? '<div class="empty-entities">No entities added yet.<br>Use the picker below to add lights, switches, or scenes.</div>'
              : `<div class="entity-list">${entities.map((e, i) => this._renderEntityItem(e, i)).join('')}</div>`
            }
            <div class="add-entity-row">
              <ha-entity-picker id="addEntityPicker" label="Add entity..."></ha-entity-picker>
            </div>
          </div>
        </div>

        <!-- Positions Section -->
        <div class="section" id="section-positions">
          <div class="section-header" data-section="positions">
            <h3>Positions</h3>
            <span class="chevron">&#9660;</span>
          </div>
          <div class="section-body">
            <div class="option-row">
              <div>
                <div class="label">Edit Positions</div>
                <div class="sublabel">Drag entities on the card preview to reposition</div>
              </div>
              <ha-switch id="cfgEditPositions"></ha-switch>
            </div>
            ${editPositions ? `
              <div class="edit-positions-banner">Position editing is active. Drag lights on the card preview above to reposition them. Changes are saved automatically.</div>
              <div class="undo-redo-row">
                <button class="action-btn" id="undoPositionsBtn" disabled title="Undo (Ctrl+Z)">&#8592; Undo</button>
                <button class="action-btn" id="redoPositionsBtn" disabled title="Redo (Ctrl+Shift+Z)">Redo &#8594;</button>
              </div>
            ` : ''}
            <button class="action-btn" id="rearrangeBtn">Rearrange All in Grid</button>
            <button class="action-btn" id="snapToGridBtn">Snap All to Grid</button>
          </div>
        </div>

        <!-- General Section -->
        <div class="section" id="section-general">
          <div class="section-header" data-section="general">
            <h3>General</h3>
            <span class="chevron">&#9660;</span>
          </div>
          <div class="section-body">
            <div class="input-row">
              <label for="cfgTitle">Title</label>
              <input type="text" id="cfgTitle" placeholder="Optional card title">
            </div>
            <div class="two-col">
              <div class="input-row">
                <label for="cfgCanvasHeight">Canvas Height (px)</label>
                <input type="number" id="cfgCanvasHeight" min="100" max="2000" step="10">
              </div>
              <div class="input-row">
                <label for="cfgGridSize">Grid Size (px)</label>
                <input type="number" id="cfgGridSize" min="5" max="100" step="5">
              </div>
            </div>
            <div class="input-row">
              <label>Background Image</label>
              <div id="cfgBgImageContainer"></div>
            </div>
            <div id="bgSettingsGroup" style="display:flex;flex-direction:column;gap:12px;">
              <div class="two-col">
                <div class="input-row">
                  <label for="cfgBgSize">Size</label>
                  <select id="cfgBgSize">
                    <option value="">Default (cover)</option>
                    <option value="cover">Cover</option>
                    <option value="contain">Contain</option>
                    <option value="auto">Auto</option>
                    <option value="100% 100%">Stretch (100% 100%)</option>
                  </select>
                </div>
                <div class="input-row">
                  <label for="cfgBgPosition">Position</label>
                  <select id="cfgBgPosition">
                    <option value="">Default (center)</option>
                    <option value="center">Center</option>
                    <option value="top">Top</option>
                    <option value="bottom">Bottom</option>
                    <option value="left">Left</option>
                    <option value="right">Right</option>
                    <option value="top left">Top Left</option>
                    <option value="top right">Top Right</option>
                    <option value="bottom left">Bottom Left</option>
                    <option value="bottom right">Bottom Right</option>
                  </select>
                </div>
              </div>
              <div class="two-col">
                <div class="input-row">
                  <label for="cfgBgRepeat">Repeat</label>
                  <select id="cfgBgRepeat">
                    <option value="">Default (no-repeat)</option>
                    <option value="no-repeat">No Repeat</option>
                    <option value="repeat">Repeat</option>
                    <option value="repeat-x">Repeat X</option>
                    <option value="repeat-y">Repeat Y</option>
                  </select>
                </div>
                <div class="input-row">
                  <label for="cfgBgBlendMode">Blend Mode</label>
                  <select id="cfgBgBlendMode">
                    <option value="">Default (normal)</option>
                    <option value="normal">Normal</option>
                    <option value="multiply">Multiply</option>
                    <option value="screen">Screen</option>
                    <option value="overlay">Overlay</option>
                    <option value="darken">Darken</option>
                    <option value="lighten">Lighten</option>
                    <option value="color-dodge">Color Dodge</option>
                    <option value="color-burn">Color Burn</option>
                    <option value="hard-light">Hard Light</option>
                    <option value="soft-light">Soft Light</option>
                    <option value="difference">Difference</option>
                    <option value="exclusion">Exclusion</option>
                    <option value="hue">Hue</option>
                    <option value="saturation">Saturation</option>
                    <option value="color">Color</option>
                    <option value="luminosity">Luminosity</option>
                  </select>
                </div>
              </div>
              <div class="input-row">
                <label>Opacity <span id="cfgBgOpacityValue" style="font-weight:400;">100%</span></label>
                <div class="slider-row">
                  <input type="range" id="cfgBgOpacity" min="0" max="100" step="1" value="100">
                </div>
              </div>
            </div>
            <div class="two-col">
              <div class="input-row">
                <label for="cfgLabelMode">Label Mode</label>
                <select id="cfgLabelMode">
                  <option value="smart">Smart</option>
                  <option value="full">Full Name</option>
                  <option value="initials">Initials</option>
                  <option value="none">None</option>
                </select>
              </div>
              <div class="input-row">
                <label>Default Entity</label>
                <ha-entity-picker id="cfgDefaultEntity" allow-custom-entity></ha-entity-picker>
              </div>
            </div>
          </div>
        </div>

        <!-- Display Section -->
        <div class="section" id="section-display">
          <div class="section-header" data-section="display">
            <h3>Display</h3>
            <span class="chevron">&#9660;</span>
          </div>
          <div class="section-body">
            <div class="option-row">
              <div><div class="label">Minimal UI</div><div class="sublabel">Hide circles, show only icons</div></div>
              <ha-switch id="cfgMinimalUI"></ha-switch>
            </div>
            <div class="option-row">
              <div><div class="label">Show Entity Icons</div><div class="sublabel">Display MDI icons on light circles</div></div>
              <ha-switch id="cfgShowIcons"></ha-switch>
            </div>
            <div class="option-row">
              <div><div class="label">Icon-Only Mode</div><div class="sublabel">Show icons without filled circles</div></div>
              <ha-switch id="cfgIconOnly"></ha-switch>
            </div>
            <div class="option-row">
              <div><div class="label">Show Live Colors</div><div class="sublabel">Display current light colors as presets</div></div>
              <ha-switch id="cfgLiveColors"></ha-switch>
            </div>
            <div class="option-row">
              <div><div class="label">Always Show Controls</div><div class="sublabel">Keep brightness/color controls visible</div></div>
              <ha-switch id="cfgAlwaysControls"></ha-switch>
            </div>
            <div class="option-row">
              <div class="label">Light Size</div>
              <div class="slider-row" style="flex:0 0 auto;">
                <input type="range" id="cfgLightSize" min="24" max="96" style="width:120px;">
                <span class="slider-value" id="cfgLightSizeValue">56px</span>
              </div>
            </div>
            <div class="option-row">
              <div class="label">Icon Rotation</div>
              <div class="slider-row" style="flex:0 0 auto;">
                <input type="range" id="cfgIconRotation" min="0" max="360" step="1" style="width:120px;">
                <span class="slider-value" id="cfgIconRotationValue">0°</span>
              </div>
            </div>
            <div class="option-row">
              <div><div class="label">Icon Mirror</div><div class="sublabel">Flip all icons horizontally or vertically</div></div>
              <select id="cfgIconMirror" style="padding:6px 10px; border-radius:6px; border:1px solid var(--divider-color, rgba(0,0,0,0.12)); background:var(--card-background-color, #fff); color:var(--primary-text-color, #212121); font-size:14px;">
                <option value="none">None</option>
                <option value="horizontal">Horizontal</option>
                <option value="vertical">Vertical</option>
                <option value="both">Both</option>
              </select>
            </div>
          </div>
        </div>

        <!-- Colors Section -->
        <div class="section collapsed" id="section-colors">
          <div class="section-header" data-section="colors">
            <h3>Colors</h3>
            <span class="chevron">&#9660;</span>
          </div>
          <div class="section-body">
            <div class="input-row">
              <label>Switch On Color</label>
              <div class="color-input-row">
                <input type="color" id="cfgSwitchOnColorPicker" value="${this._esc(config.switch_on_color || '#ffa500')}">
                <input type="text" id="cfgSwitchOnColor" placeholder="#ffa500">
              </div>
            </div>
            <div class="input-row">
              <label>Switch Off Color</label>
              <div class="color-input-row">
                <input type="color" id="cfgSwitchOffColorPicker" value="${this._esc(config.switch_off_color || '#3a3a3a')}">
                <input type="text" id="cfgSwitchOffColor" placeholder="#3a3a3a">
              </div>
            </div>
            <div class="input-row">
              <label>Scene Color</label>
              <div class="color-input-row">
                <input type="color" id="cfgSceneColorPicker" value="${this._esc(config.scene_color || '#6366f1')}">
                <input type="text" id="cfgSceneColor" placeholder="#6366f1">
              </div>
            </div>
            <div class="input-row">
              <label>Binary Sensor On Color</label>
              <div class="color-input-row">
                <input type="color" id="cfgBinarySensorOnColorPicker" value="${this._esc(config.binary_sensor_on_color || '#4caf50')}">
                <input type="text" id="cfgBinarySensorOnColor" placeholder="#4caf50">
              </div>
            </div>
            <div class="input-row">
              <label>Binary Sensor Off Color</label>
              <div class="color-input-row">
                <input type="color" id="cfgBinarySensorOffColorPicker" value="${this._esc(config.binary_sensor_off_color || '#2a2a2a')}">
                <input type="text" id="cfgBinarySensorOffColor" placeholder="#2a2a2a">
              </div>
            </div>
            <div class="input-row">
              <label>Color Presets</label>
              <div class="color-presets-list" id="colorPresetsList">
                ${presets.map((c, i) => `
                  <div class="color-preset-chip" data-index="${i}" style="background:${this._esc(c)};" title="${this._esc(c)}">
                    <span class="remove-preset" data-index="${i}">&times;</span>
                  </div>
                `).join('')}
                <button class="add-preset-btn" id="addPresetBtn" title="Add color preset">+</button>
              </div>
              <input type="color" id="presetColorPicker" style="display:none;">
            </div>
          </div>
        </div>

        <!-- Temperature Section -->
        <div class="section collapsed" id="section-temperature">
          <div class="section-header" data-section="temperature">
            <h3>Temperature Range</h3>
            <span class="chevron">&#9660;</span>
          </div>
          <div class="section-body">
            <div class="two-col">
              <div class="input-row">
                <label for="cfgTempMin">Min Temperature (K)</label>
                <input type="number" id="cfgTempMin" min="1000" max="10000" step="100" placeholder="Auto">
              </div>
              <div class="input-row">
                <label for="cfgTempMax">Max Temperature (K)</label>
                <input type="number" id="cfgTempMax" min="1000" max="10000" step="100" placeholder="Auto">
              </div>
            </div>
          </div>
        </div>

        <!-- Layout Section -->
        <div class="section collapsed" id="section-layout">
          <div class="section-header" data-section="layout">
            <h3>Layout</h3>
            <span class="chevron">&#9660;</span>
          </div>
          <div class="section-body">
            <div class="option-row">
              <div><div class="label">Controls Below Canvas</div><div class="sublabel">Place controls below instead of floating overlay</div></div>
              <ha-switch id="cfgControlsBelow"></ha-switch>
            </div>
          </div>
        </div>

        <!-- Interaction Section -->
        <div class="section collapsed" id="section-interaction">
          <div class="section-header" data-section="interaction">
            <h3>Interaction</h3>
            <span class="chevron">&#9660;</span>
          </div>
          <div class="section-body">
            <div class="option-row">
              <div><div class="label">Single-Tap for Switches &amp; Scenes</div><div class="sublabel">Toggle switches and activate scenes with one tap</div></div>
              <ha-switch id="cfgSwitchTap"></ha-switch>
            </div>
          </div>
        </div>

      </div>
    `;

    this._setDOMValues();
    this._attachEditorListeners();
    // Setup entity pickers after DOM is ready
    requestAnimationFrame(() => {
      this._setupEntityPickers();
      // Double-ensure in case custom element wasn't upgraded yet
      setTimeout(() => this._setupEntityPickers(), 100);
    });
  }

  _setDOMValues() {
    const root = this.shadowRoot;
    const c = this._config;

    const setVal = (id, val) => { const el = root.getElementById(id); if (el) el.value = val; };
    setVal('cfgTitle', c.title || '');
    setVal('cfgCanvasHeight', c.canvas_height || 450);
    setVal('cfgGridSize', c.grid_size || 25);
    setVal('cfgLabelMode', c.label_mode || 'smart');
    setVal('cfgLightSize', c.light_size || 56);

    const lsv = root.getElementById('cfgLightSizeValue');
    if (lsv) lsv.textContent = `${c.light_size || 56}px`;

    setVal('cfgIconRotation', c.icon_rotation || 0);
    const irv = root.getElementById('cfgIconRotationValue');
    if (irv) irv.textContent = `${c.icon_rotation || 0}°`;
    setVal('cfgIconMirror', c.icon_mirror || 'none');

    // Background image (ha-picture-upload created programmatically after lazy load)
    let bgUrl = '';
    if (c.background_image) {
      bgUrl = typeof c.background_image === 'string' ? c.background_image : (c.background_image.url || '');
    }
    this._initBgUpload(bgUrl);

    // Background image settings
    const bgObj = (c.background_image && typeof c.background_image === 'object') ? c.background_image : {};
    const setSelectVal = (id, val) => {
      const el = root.getElementById(id);
      if (!el) return;
      const targetVal = val || '';
      let found = false;
      for (const opt of el.options) { if (opt.value === targetVal) { found = true; break; } }
      if (!found && targetVal) {
        const opt = document.createElement('option');
        opt.value = targetVal;
        opt.textContent = targetVal;
        el.appendChild(opt);
      }
      el.value = targetVal;
    };
    setSelectVal('cfgBgSize', bgObj.size || '');
    setSelectVal('cfgBgPosition', bgObj.position || '');
    setSelectVal('cfgBgRepeat', bgObj.repeat || '');
    setSelectVal('cfgBgBlendMode', bgObj.blend_mode || '');
    const bgOpacityPct = bgObj.opacity !== undefined ? Math.round(bgObj.opacity * 100) : 100;
    setVal('cfgBgOpacity', bgOpacityPct);
    const bgOpacityLabel = root.getElementById('cfgBgOpacityValue');
    if (bgOpacityLabel) bgOpacityLabel.textContent = `${bgOpacityPct}%`;

    // Colors
    setVal('cfgSwitchOnColor', c.switch_on_color || '#ffa500');
    setVal('cfgSwitchOnColorPicker', c.switch_on_color || '#ffa500');
    setVal('cfgSwitchOffColor', c.switch_off_color || '#3a3a3a');
    setVal('cfgSwitchOffColorPicker', c.switch_off_color || '#3a3a3a');
    setVal('cfgSceneColor', c.scene_color || '#6366f1');
    setVal('cfgSceneColorPicker', c.scene_color || '#6366f1');
    setVal('cfgBinarySensorOnColor', c.binary_sensor_on_color || '#4caf50');
    setVal('cfgBinarySensorOnColorPicker', c.binary_sensor_on_color || '#4caf50');
    setVal('cfgBinarySensorOffColor', c.binary_sensor_off_color || '#2a2a2a');
    setVal('cfgBinarySensorOffColorPicker', c.binary_sensor_off_color || '#2a2a2a');

    // Temperature
    setVal('cfgTempMin', c.temperature_min != null ? c.temperature_min : '');
    setVal('cfgTempMax', c.temperature_max != null ? c.temperature_max : '');

    // Switches
    const switches = {
      cfgEditPositions: !!c._edit_positions,
      cfgMinimalUI: c.minimal_ui || false,
      cfgShowIcons: c.show_entity_icons !== false,
      cfgIconOnly: c.icon_only_mode || false,
      cfgLiveColors: c.show_live_colors || false,
      cfgAlwaysControls: c.always_show_controls || false,
      cfgControlsBelow: c.controls_below !== false,
      cfgSwitchTap: c.switch_single_tap || false,
    };
    const setChecked = () => {
      Object.entries(switches).forEach(([id, val]) => {
        const el = root.getElementById(id);
        if (el) el.checked = val;
      });
    };
    setChecked();
    requestAnimationFrame(() => setChecked());

    // Per-entity icon-only switches
    requestAnimationFrame(() => {
      root.querySelectorAll('.entity-overrides ha-switch[data-key="iconOnly"]').forEach(sw => {
        const entity = sw.dataset.entity;
        const override = c.icon_only_overrides && c.icon_only_overrides[entity];
        sw.checked = override !== undefined ? override : false;
      });
    });
  }

  _attachEditorListeners() {
    const root = this.shadowRoot;

    // Section collapse
    root.querySelectorAll('.section-header').forEach(h => {
      h.addEventListener('click', () => h.closest('.section').classList.toggle('collapsed'));
    });

    // --- Edit Positions toggle ---
    const editPosSwitch = root.getElementById('cfgEditPositions');
    if (editPosSwitch) {
      editPosSwitch.addEventListener('change', () => {
        if (editPosSwitch.checked) {
          this._config._edit_positions = true;
          this._config._editor_id = this._editorId;
        } else {
          delete this._config._edit_positions;
          delete this._config._editor_id;
        }
        this._fireConfigChanged();
        this._render();
      });
    }

    // --- Undo/Redo buttons ---
    const undoBtn = root.getElementById('undoPositionsBtn');
    const redoBtn = root.getElementById('redoPositionsBtn');
    if (undoBtn) {
      undoBtn.addEventListener('click', () => this._undoPositions());
    }
    if (redoBtn) {
      redoBtn.addEventListener('click', () => this._redoPositions());
    }

    // --- Rearrange button ---
    const rearrangeBtn = root.getElementById('rearrangeBtn');
    if (rearrangeBtn) {
      rearrangeBtn.addEventListener('click', () => {
        const entities = this._config.entities || [];
        if (entities.length === 0) return;
        this._pushPositionHistory();
        const cols = Math.ceil(Math.sqrt(entities.length * 1.5));
        const rows = Math.ceil(entities.length / cols);
        const spacing = 100 / (cols + 1);
        const newPositions = {};
        entities.forEach((entity, idx) => {
          const col = idx % cols;
          const row = Math.floor(idx / cols);
          newPositions[entity] = {
            x: spacing * (col + 1),
            y: (100 / (rows + 1)) * (row + 1),
          };
        });
        this._config.positions = newPositions;
        this._fireConfigChanged();
      });
    }

    // --- Snap to grid ---
    const snapBtn = root.getElementById('snapToGridBtn');
    if (snapBtn) {
      snapBtn.addEventListener('click', () => {
        const entities = this._config.entities || [];
        if (entities.length === 0) return;
        this._pushPositionHistory();
        const positions = this._config.positions || {};
        const gridSize = this._config.grid_size || 25;
        const canvasHeight = this._config.canvas_height || 450;
        // Assume a roughly square-ish canvas; use height for both axes as an approximation.
        // Grid snapping works in pixel space, so we convert % -> px, snap, convert back.
        // We don't have the actual canvas width, so estimate from a typical card (~450px wide).
        const canvasWidth = canvasHeight; // reasonable default; grid is square anyway
        const newPositions = {};
        entities.forEach((entity) => {
          const pos = positions[entity];
          if (!pos) {
            newPositions[entity] = { x: 50, y: 50 };
            return;
          }
          const px = (pos.x / 100) * canvasWidth;
          const py = (pos.y / 100) * canvasHeight;
          const sx = Math.round(px / gridSize) * gridSize;
          const sy = Math.round(py / gridSize) * gridSize;
          newPositions[entity] = {
            x: Math.max(0, Math.min(100, (sx / canvasWidth) * 100)),
            y: Math.max(0, Math.min(100, (sy / canvasHeight) * 100)),
          };
        });
        this._config.positions = newPositions;
        this._fireConfigChanged();
      });
    }

    // --- Entity expand/collapse ---
    const toggleExpand = (entityItem) => {
      const entity = entityItem.dataset.entity;
      this._expandedEntity = (this._expandedEntity === entity) ? null : entity;
      root.querySelectorAll('.entity-item').forEach(item => {
        item.classList.toggle('expanded', item.dataset.entity === this._expandedEntity);
      });
    };
    root.querySelectorAll('.entity-main').forEach(main => {
      main.addEventListener('click', (e) => {
        if (e.target.closest('.entity-btn')) return;
        toggleExpand(main.closest('.entity-item'));
      });
    });
    root.querySelectorAll('.entity-btn.expand').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleExpand(btn.closest('.entity-item'));
      });
    });

    // --- Entity remove ---
    root.querySelectorAll('.entity-btn.remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.index, 10);
        const entity = this._config.entities[idx];
        this._config.entities.splice(idx, 1);
        if (this._config.positions) delete this._config.positions[entity];
        if (this._config.size_overrides) delete this._config.size_overrides[entity];
        if (this._config.icon_only_overrides) delete this._config.icon_only_overrides[entity];
        if (this._config.label_overrides) delete this._config.label_overrides[entity];
        if (this._config.color_overrides) delete this._config.color_overrides[entity];
        if (this._config.icon_rotation_overrides) delete this._config.icon_rotation_overrides[entity];
        if (this._config.icon_mirror_overrides) delete this._config.icon_mirror_overrides[entity];
        if (this._expandedEntity === entity) this._expandedEntity = null;
        this._fireConfigChanged();
        this._render();
      });
    });

    // --- Add entity picker ---
    const addPicker = root.getElementById('addEntityPicker');
    if (addPicker) {
      // Listen on both the picker and via event delegation for value-changed
      const handleAdd = (val) => {
        if (val && !(this._config.entities || []).includes(val)) {
          if (!this._config.entities) this._config.entities = [];
          this._config.entities.push(val);
          this._fireConfigChanged();
          this._render();
        }
      };
      addPicker.addEventListener('value-changed', (ev) => {
        handleAdd(ev.detail && ev.detail.value);
      });
      addPicker.addEventListener('change', () => {
        handleAdd(addPicker.value);
      });
    }

    // --- Per-entity overrides ---
    root.querySelectorAll('.entity-overrides input[data-key="label"]').forEach(inp => {
      this._bindEntityOverride(inp, (entity, val) => {
        if (!this._config.label_overrides) this._config.label_overrides = {};
        if (val) { this._config.label_overrides[entity] = val; }
        else { delete this._config.label_overrides[entity]; }
      });
    });

    root.querySelectorAll('.entity-overrides input[data-key="size"]').forEach(inp => {
      this._bindEntityOverride(inp, (entity, val) => {
        if (!this._config.size_overrides) this._config.size_overrides = {};
        const num = parseInt(val, 10);
        if (Number.isFinite(num) && num > 0) { this._config.size_overrides[entity] = num; }
        else { delete this._config.size_overrides[entity]; }
      });
    });

    root.querySelectorAll('.entity-overrides input[data-key="color_on"]').forEach(inp => {
      this._bindEntityOverride(inp, (entity, val) => {
        if (!this._config.color_overrides) this._config.color_overrides = {};
        const existing = this._config.color_overrides[entity];
        const cur = (existing && typeof existing === 'object') ? existing : {};
        if (val) { cur.state_on = val; } else { delete cur.state_on; }
        if (cur.state_on || cur.state_off) { this._config.color_overrides[entity] = cur; }
        else { delete this._config.color_overrides[entity]; }
        const preview = root.querySelector(`.color-preview[data-entity="${entity}"][data-state="on"]`);
        if (preview) preview.style.background = val || 'transparent';
      });
    });

    root.querySelectorAll('.entity-overrides input[data-key="color_off"]').forEach(inp => {
      this._bindEntityOverride(inp, (entity, val) => {
        if (!this._config.color_overrides) this._config.color_overrides = {};
        const existing = this._config.color_overrides[entity];
        const cur = (existing && typeof existing === 'object') ? existing : {};
        if (val) { cur.state_off = val; } else { delete cur.state_off; }
        if (cur.state_on || cur.state_off) { this._config.color_overrides[entity] = cur; }
        else { delete this._config.color_overrides[entity]; }
        const preview = root.querySelector(`.color-preview[data-entity="${entity}"][data-state="off"]`);
        if (preview) preview.style.background = val || 'transparent';
      });
    });

    // Per-entity icon-only switch
    requestAnimationFrame(() => {
      root.querySelectorAll('.entity-overrides ha-switch[data-key="iconOnly"]').forEach(sw => {
        sw.addEventListener('change', () => {
          const entity = sw.dataset.entity;
          if (!this._config.icon_only_overrides) this._config.icon_only_overrides = {};
          if (sw.checked) { this._config.icon_only_overrides[entity] = true; }
          else { delete this._config.icon_only_overrides[entity]; }
          this._fireConfigChanged();
        });
      });
    });

    // Per-entity icon rotation override
    root.querySelectorAll('.entity-overrides input[data-key="icon_rotation"]').forEach(inp => {
      this._bindEntityOverride(inp, (entity, val) => {
        if (!this._config.icon_rotation_overrides) this._config.icon_rotation_overrides = {};
        const num = parseInt(val, 10);
        if (Number.isFinite(num)) { this._config.icon_rotation_overrides[entity] = num; }
        else { delete this._config.icon_rotation_overrides[entity]; }
      });
    });

    // Per-entity icon mirror override
    root.querySelectorAll('.entity-overrides select[data-key="icon_mirror"]').forEach(sel => {
      sel.addEventListener('change', () => {
        const entity = sel.dataset.entity;
        if (!this._config.icon_mirror_overrides) this._config.icon_mirror_overrides = {};
        if (sel.value && sel.value !== '') {
          this._config.icon_mirror_overrides[entity] = sel.value;
        } else {
          delete this._config.icon_mirror_overrides[entity];
        }
        this._fireConfigChanged();
      });
    });

    // --- General inputs ---
    this._bindTextInput('cfgTitle', (val) => { this._config.title = val; });
    this._bindNumberInput('cfgCanvasHeight', (val) => { if (val >= 100 && val <= 2000) this._config.canvas_height = val; });
    this._bindNumberInput('cfgGridSize', (val) => { if (val >= 5 && val <= 100) this._config.grid_size = val; });
    // Default entity picker
    const defEntityPicker = root.getElementById('cfgDefaultEntity');
    if (defEntityPicker) {
      defEntityPicker.addEventListener('value-changed', (ev) => {
        this._config.default_entity = ev.detail.value || null;
        this._fireConfigChanged();
      });
      defEntityPicker.addEventListener('change', () => {
        this._config.default_entity = defEntityPicker.value || null;
        this._fireConfigChanged();
      });
    }

    const labelModeEl = root.getElementById('cfgLabelMode');
    if (labelModeEl) {
      labelModeEl.addEventListener('change', () => {
        this._config.label_mode = labelModeEl.value;
        this._fireConfigChanged();
      });
    }

    // Background image event listener is attached in _initBgUpload()

    // --- Background image settings ---
    const bgSettingChanged = () => {
      // Convert string to object if needed
      if (typeof this._config.background_image === 'string') {
        this._config.background_image = { url: this._config.background_image };
      }
      if (!this._config.background_image) {
        this._config.background_image = {};
      }
      const bg = this._config.background_image;
      const bgSizeEl = root.getElementById('cfgBgSize');
      const bgPosEl = root.getElementById('cfgBgPosition');
      const bgRepeatEl = root.getElementById('cfgBgRepeat');
      const bgBlendEl = root.getElementById('cfgBgBlendMode');
      const bgOpacityEl = root.getElementById('cfgBgOpacity');
      if (bgSizeEl) { if (bgSizeEl.value) bg.size = bgSizeEl.value; else delete bg.size; }
      if (bgPosEl) { if (bgPosEl.value) bg.position = bgPosEl.value; else delete bg.position; }
      if (bgRepeatEl) { if (bgRepeatEl.value) bg.repeat = bgRepeatEl.value; else delete bg.repeat; }
      if (bgBlendEl) { if (bgBlendEl.value) bg.blend_mode = bgBlendEl.value; else delete bg.blend_mode; }
      if (bgOpacityEl) {
        const pct = parseInt(bgOpacityEl.value, 10);
        if (Number.isFinite(pct) && pct < 100) bg.opacity = parseFloat((pct / 100).toFixed(2));
        else delete bg.opacity;
      }
      // If empty object (no url, no settings), set to null
      if (Object.keys(bg).length === 0) {
        this._config.background_image = null;
      }
      this._fireConfigChanged();
    };
    ['cfgBgSize', 'cfgBgPosition', 'cfgBgRepeat', 'cfgBgBlendMode'].forEach(id => {
      const el = root.getElementById(id);
      if (el) el.addEventListener('change', bgSettingChanged);
    });
    const bgOpacitySlider = root.getElementById('cfgBgOpacity');
    const bgOpacityValLabel = root.getElementById('cfgBgOpacityValue');
    if (bgOpacitySlider) {
      bgOpacitySlider.addEventListener('input', () => {
        if (bgOpacityValLabel) bgOpacityValLabel.textContent = `${bgOpacitySlider.value}%`;
      });
      bgOpacitySlider.addEventListener('change', bgSettingChanged);
    }

    // --- Display/Layout/Interaction toggles ---
    this._bindSwitch('cfgMinimalUI', 'minimal_ui');
    this._bindSwitch('cfgShowIcons', 'show_entity_icons');
    this._bindSwitch('cfgIconOnly', 'icon_only_mode');
    this._bindSwitch('cfgLiveColors', 'show_live_colors');
    this._bindSwitch('cfgAlwaysControls', 'always_show_controls');
    this._bindSwitch('cfgControlsBelow', 'controls_below');
    this._bindSwitch('cfgSwitchTap', 'switch_single_tap');

    // Light size slider
    const lsSlider = root.getElementById('cfgLightSize');
    const lsVal = root.getElementById('cfgLightSizeValue');
    if (lsSlider) {
      lsSlider.addEventListener('input', () => { if (lsVal) lsVal.textContent = `${lsSlider.value}px`; });
      lsSlider.addEventListener('change', () => {
        const v = parseInt(lsSlider.value, 10);
        if (Number.isFinite(v) && v > 0) { this._config.light_size = v; this._fireConfigChanged(); }
      });
    }

    // Icon rotation slider
    const irSlider = root.getElementById('cfgIconRotation');
    const irVal = root.getElementById('cfgIconRotationValue');
    if (irSlider) {
      irSlider.addEventListener('input', () => { if (irVal) irVal.textContent = `${irSlider.value}°`; });
      irSlider.addEventListener('change', () => {
        const v = parseInt(irSlider.value, 10);
        if (Number.isFinite(v)) { this._config.icon_rotation = v; this._fireConfigChanged(); }
      });
    }

    // Icon mirror select
    const mirrorEl = root.getElementById('cfgIconMirror');
    if (mirrorEl) {
      mirrorEl.addEventListener('change', () => {
        this._config.icon_mirror = mirrorEl.value === 'none' ? 'none' : mirrorEl.value;
        this._fireConfigChanged();
      });
    }

    // --- Color inputs (synced picker + text) ---
    this._bindColorPair('cfgSwitchOnColor', 'cfgSwitchOnColorPicker', 'switch_on_color', '#ffa500');
    this._bindColorPair('cfgSwitchOffColor', 'cfgSwitchOffColorPicker', 'switch_off_color', '#3a3a3a');
    this._bindColorPair('cfgSceneColor', 'cfgSceneColorPicker', 'scene_color', '#6366f1');
    this._bindColorPair('cfgBinarySensorOnColor', 'cfgBinarySensorOnColorPicker', 'binary_sensor_on_color', '#4caf50');
    this._bindColorPair('cfgBinarySensorOffColor', 'cfgBinarySensorOffColorPicker', 'binary_sensor_off_color', '#2a2a2a');

    // --- Color presets ---
    root.querySelectorAll('.color-preset-chip .remove-preset').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.index, 10);
        if (!Array.isArray(this._config.color_presets)) return;
        this._config.color_presets.splice(idx, 1);
        this._fireConfigChanged();
        this._render();
      });
    });

    const addPresetBtn = root.getElementById('addPresetBtn');
    const presetPicker = root.getElementById('presetColorPicker');
    if (addPresetBtn && presetPicker) {
      addPresetBtn.addEventListener('click', () => presetPicker.click());
      presetPicker.addEventListener('input', (e) => {
        const color = e.target.value;
        if (!Array.isArray(this._config.color_presets)) this._config.color_presets = [];
        this._config.color_presets.push(color);
        this._fireConfigChanged();
        this._render();
      });
    }

    // --- Temperature inputs ---
    this._bindNumberInput('cfgTempMin', (val) => {
      this._config.temperature_min = (val >= 1000 && val <= 10000) ? val : null;
    });
    this._bindNumberInput('cfgTempMax', (val) => {
      this._config.temperature_max = (val >= 1000 && val <= 10000) ? val : null;
    });
  }

  _bindColorPair(textId, pickerId, configKey, fallback) {
    const root = this.shadowRoot;
    const textEl = root.getElementById(textId);
    const pickerEl = root.getElementById(pickerId);
    if (!textEl || !pickerEl) return;

    let timer = null;
    textEl.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const val = textEl.value.trim();
        if (val) {
          this._config[configKey] = val;
          // Try to sync picker (only valid 6-digit hex)
          if (/^#[0-9a-fA-F]{6}$/.test(val)) pickerEl.value = val;
        } else {
          this._config[configKey] = fallback;
          pickerEl.value = fallback;
        }
        this._fireConfigChanged();
      }, 400);
    });
    textEl.addEventListener('change', () => {
      clearTimeout(timer);
      const val = textEl.value.trim() || fallback;
      this._config[configKey] = val;
      if (/^#[0-9a-fA-F]{6}$/.test(val)) pickerEl.value = val;
      this._fireConfigChanged();
    });

    pickerEl.addEventListener('input', () => {
      textEl.value = pickerEl.value;
      this._config[configKey] = pickerEl.value;
      this._fireConfigChanged();
    });
  }

  _bindEntityOverride(inputEl, setter) {
    let timer = null;
    const apply = () => {
      clearTimeout(timer);
      setter(inputEl.dataset.entity, inputEl.value);
      this._fireConfigChanged();
    };
    inputEl.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(apply, 400); });
    inputEl.addEventListener('change', apply);
  }

  _bindTextInput(id, setter) {
    const el = this.shadowRoot.getElementById(id);
    if (!el) return;
    let t = null;
    el.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { setter(el.value); this._fireConfigChanged(); }, 300); });
    el.addEventListener('change', () => { clearTimeout(t); setter(el.value); this._fireConfigChanged(); });
  }

  _bindNumberInput(id, setter) {
    const el = this.shadowRoot.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => {
      const raw = el.value.trim();
      if (raw === '') { setter(null); this._fireConfigChanged(); return; }
      const v = parseInt(raw, 10);
      if (Number.isFinite(v)) { setter(v); this._fireConfigChanged(); }
    });
  }

  _bindSwitch(id, key) {
    const el = this.shadowRoot.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => { this._config[key] = el.checked; this._fireConfigChanged(); });
  }
}

customElements.define('spatial-light-color-card-editor', SpatialLightColorCardEditor);
customElements.define('spatial-light-color-card', SpatialLightColorCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'spatial-light-color-card',
  name: 'Spatial Light Color Card',
  description: 'Refined spatial light control with intelligent interactions and polished design',
  preview: true,
});

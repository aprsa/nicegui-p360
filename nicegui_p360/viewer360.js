export default {
  template: `<div ref="container" :style="containerStyle"></div>`,

  props: {
    spriteSrc:       { type: String,  default: null },
    framesSrc:       { type: Array,   default: null },

    // geometry — null by default in sprite mode; read from XMP if so
    frameCount:      { type: Number,  default: null },
    cols:            { type: Number,  default: null },
    frameWidth:      { type: Number,  default: null },
    frameHeight:     { type: Number,  default: null },

    // display & interaction:
    displayWidth:    { type: Number,  default: 600 },
    dragSensitivity: { type: Number,  default: 8 },
    autoSpin:        { type: Number,  default: 0 },
    background:      { type: String,  default: 'transparent' },
  },

  data() {
    return {
      // geometry (from props or XMP):
      resolvedFrameCount: null,
      resolvedCols:       null,
      resolvedFrameW:     null,
      resolvedFrameH:     null,
      ready:        false,   // true once geometry is known and images loaded

      currentFrame: 0,
      isDragging:   false,
      dragStartX:   0,
      dragAccum:    0,
      spinTimer:    null,
      images:       [],      // sequence mode only
    };
  },

  computed: {
    scale() {
      return this.resolvedFrameW ? this.displayWidth / this.resolvedFrameW : 1;
    },
    displayHeight() {
      return this.resolvedFrameH ? Math.round(this.resolvedFrameH * this.scale) : 0;
    },
    spriteW() {
      return this.resolvedCols ? Math.round(this.resolvedFrameW * this.resolvedCols * this.scale) : 0;
    },
    spriteH() {
      if (!this.resolvedFrameCount || !this.resolvedCols || !this.resolvedFrameH) return 0;
      return Math.round(this.resolvedFrameH * Math.ceil(this.resolvedFrameCount / this.resolvedCols) * this.scale);
    },
    containerStyle() {
      const base = {
        width:           `${this.displayWidth}px`,
        height:          `${this.displayHeight}px`,
        backgroundColor: this.background,
        cursor:          this.isDragging ? 'grabbing' : 'grab',
        userSelect:      'none',
        visibility:      this.ready ? 'visible' : 'hidden',
      };
      if (this.spriteSrc && this.ready) {
        const col = this.currentFrame % this.resolvedCols;
        const row = Math.floor(this.currentFrame / this.resolvedCols);
        return {
          ...base,
          backgroundImage:    `url('${this.spriteSrc}')`,
          backgroundSize:     `${this.spriteW}px ${this.spriteH}px`,
          backgroundPosition: `${-(col * this.displayWidth)}px ${-(row * this.displayHeight)}px`,
          backgroundRepeat:   'no-repeat',
        };
      }
      return base;
    },
  },

  async mounted() {
    // resolve geometry -- either passed explicitly or read from XMP in the sprite:
    if (this.frameCount !== null && this.cols !== null &&
        this.frameWidth !== null && this.frameHeight !== null) {
      // if parameters are provided explicitly — use as-is:
      this.resolvedFrameCount = this.frameCount;
      this.resolvedCols       = this.cols;
      this.resolvedFrameW     = this.frameWidth;
      this.resolvedFrameH     = this.frameHeight;
    } else if (this.spriteSrc) {
      // otherwise read geometry from XMP embedded in the sprite:
      const meta = await this._readXmp(this.spriteSrc);
      this.resolvedFrameCount = this.frameCount  ?? meta.frame_count;
      this.resolvedCols       = this.cols        ?? meta.cols;
      this.resolvedFrameW     = this.frameWidth  ?? meta.frame_width;
      this.resolvedFrameH     = this.frameHeight ?? meta.frame_height;
    }

    // load assets:
    if (this.spriteSrc) {
      await this._loadSprite();
    } else if (this.framesSrc) {
      this._canvas = document.createElement('canvas');
      this._canvas.width  = this.displayWidth;
      this._canvas.height = this.displayHeight;
      this._canvas.style.cssText = `display:block;width:${this.displayWidth}px;height:${this.displayHeight}px;`;
      this.$refs.container.appendChild(this._canvas);
      this._ctx = this._canvas.getContext('2d');
      await this._loadSequence();
    }

    this.ready = true;
    if (this._ctx) this._drawFrame(0);
    if (this.autoSpin > 0) this._startSpin();

    // event listeners:
    this.$refs.container.addEventListener('mousedown',  this._onMouseDown);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mouseup',   this._onMouseUp);
    this.$refs.container.addEventListener('touchstart', this._onTouchStart, { passive: false });
    window.addEventListener('touchmove',  this._onTouchMove, { passive: false });
    window.addEventListener('touchend',   this._onTouchEnd);
  },

  beforeUnmount() {
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mouseup',   this._onMouseUp);
    window.removeEventListener('touchmove', this._onTouchMove);
    window.removeEventListener('touchend',  this._onTouchEnd);
    this._stopSpin();
  },

  methods: {
    // XMP inference:
    async _readXmp(url) {
      try {
        const res    = await fetch(url);
        const buf    = await res.arrayBuffer();
        const bytes  = new Uint8Array(buf);
        // XMP in WebP is a UTF-8 string chunk; find it by searching for the marker
        const marker = '<x:xmpmeta';
        const end    = '</x:xmpmeta>';
        const text   = new TextDecoder().decode(bytes);
        const start  = text.indexOf(marker);
        const finish = text.indexOf(end);
        if (start === -1 || finish === -1) {
          console.warn('nicegui-p360: no XMP metadata found in sprite.');
          return {};
        }
        const xmp    = text.slice(start, finish + end.length);
        const fields = ['frame_count', 'cols', 'frame_width', 'frame_height'];
        const meta   = {};
        for (const f of fields) {
          const m = xmp.match(new RegExp(`<p360:${f}>(\\d+)</p360:${f}>`));
          if (m) meta[f] = parseInt(m[1]);
        }
        return meta;
      } catch (e) {
        console.warn('nicegui-p360: failed to read XMP from sprite:', e);
        return {};
      }
    },

    // sprite loading:
    _loadSprite() {
      return new Promise(resolve => {
        const img  = new Image();
        img.onload = resolve;
        img.onerror = resolve; // don't hang on error
        img.src    = this.spriteSrc;
      });
    },

    // sequence loading:
    _loadSequence() {
      return new Promise(resolve => {
        let loaded = 0;
        this.images = this.framesSrc.map(src => {
          const img  = new Image();
          img.onload = () => { if (++loaded === this.framesSrc.length) resolve(); };
          img.onerror = () => { if (++loaded === this.framesSrc.length) resolve(); };
          img.src    = src;
          return img;
        });
      });
    },

    // frame widget actions:
    showFrame(i) {
      this.currentFrame = ((i % this.resolvedFrameCount) + this.resolvedFrameCount) % this.resolvedFrameCount;
      if (this._ctx) this._drawFrame(this.currentFrame);
    },

    _drawFrame(i) {
      if (!this.images[i]) return;
      this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
      this._ctx.drawImage(this.images[i], 0, 0, this._canvas.width, this._canvas.height);
    },

    // spin control:
    _startSpin() {
      const msPerFrame = (60 * 1000) / (this.autoSpin * this.resolvedFrameCount);
      this.spinTimer = setInterval(() => this.showFrame(this.currentFrame + 1), msPerFrame);
    },

    _stopSpin() {
      if (this.spinTimer) { clearInterval(this.spinTimer); this.spinTimer = null; }
    },

    // drag control:
    _startDrag(clientX) {
      this._stopSpin();
      this.isDragging = true;
      this.dragStartX = clientX;
      this.dragAccum  = 0;
    },

    _moveDrag(clientX) {
      if (!this.isDragging) return;
      this.dragAccum += clientX - this.dragStartX;
      this.dragStartX = clientX;
      const steps = Math.trunc(this.dragAccum / this.dragSensitivity);
      if (steps !== 0) {
        this.showFrame(this.currentFrame + steps);
        this.dragAccum -= steps * this.dragSensitivity;
      }
    },

    _endDrag() { this.isDragging = false; },

    _onMouseDown(e) { this._startDrag(e.clientX); e.preventDefault(); },
    _onMouseMove(e) { this._moveDrag(e.clientX); },
    _onMouseUp()    { this._endDrag(); },

    _onTouchStart(e) { this._startDrag(e.touches[0].clientX); e.preventDefault(); },
    _onTouchMove(e)  { this._moveDrag(e.touches[0].clientX);  e.preventDefault(); },
    _onTouchEnd()    { this._endDrag(); },
  },
};

// Interactive square crop box over an <img>. Reports the crop rectangle in
// the image's natural (unscaled) pixel coordinates whenever it changes.

class Cropper {
  constructor(container, img, box, onChange) {
    this.container = container;
    this.img = img;
    this.box = box;
    this.handles = box.querySelectorAll(".crop-handle");
    this.onChange = onChange;

    this.displayW = 0;
    this.displayH = 0;
    this.offsetX = 0; // top-left of the rendered (object-fit: contain) image within the container
    this.offsetY = 0;
    this.scale = 1; // natural px per display px
    this.rect = { x: 0, y: 0, size: 0 }; // display-space, relative to offsetX/offsetY

    this._bindEvents();
    window.addEventListener("resize", () => {
      if (this.img.naturalWidth) this.reset();
    });
  }

  reset() {
    const cw = this.container.clientWidth;
    const ch = this.container.clientHeight;
    const naturalW = this.img.naturalWidth;
    const naturalH = this.img.naturalHeight;
    const containerRatio = cw / ch;
    const imgRatio = naturalW / naturalH;

    if (imgRatio > containerRatio) {
      this.displayW = cw;
      this.displayH = cw / imgRatio;
    } else {
      this.displayH = ch;
      this.displayW = ch * imgRatio;
    }
    this.offsetX = (cw - this.displayW) / 2;
    this.offsetY = (ch - this.displayH) / 2;
    this.scale = naturalW / this.displayW;

    const size = Math.min(this.displayW, this.displayH) * 0.9;
    this.rect = {
      x: (this.displayW - size) / 2,
      y: (this.displayH - size) / 2,
      size,
    };
    this._render();
    this._emit();
  }

  _render() {
    const { x, y, size } = this.rect;
    this.box.style.left = `${this.offsetX + x}px`;
    this.box.style.top = `${this.offsetY + y}px`;
    this.box.style.width = `${size}px`;
    this.box.style.height = `${size}px`;
  }

  _emit() {
    const r = this.rect;
    const naturalW = this.img.naturalWidth;
    const naturalH = this.img.naturalHeight;
    let x = Math.round(r.x * this.scale);
    let y = Math.round(r.y * this.scale);
    let size = Math.round(r.size * this.scale);
    x = Math.min(Math.max(0, x), naturalW - 1);
    y = Math.min(Math.max(0, y), naturalH - 1);
    size = Math.min(size, naturalW - x, naturalH - y);
    this.onChange({ x, y, size });
  }

  _bindEvents() {
    let dragMode = null;
    let start = null;

    const pointerDown = (e, mode) => {
      e.preventDefault();
      dragMode = mode;
      start = { px: e.clientX, py: e.clientY, rect: { ...this.rect } };
      window.addEventListener("pointermove", pointerMove);
      window.addEventListener("pointerup", pointerUp);
    };

    const pointerMove = (e) => {
      if (!dragMode) return;
      const dx = e.clientX - start.px;
      const dy = e.clientY - start.py;

      if (dragMode === "move") {
        let x = start.rect.x + dx;
        let y = start.rect.y + dy;
        x = Math.min(this.displayW - this.rect.size, Math.max(0, x));
        y = Math.min(this.displayH - this.rect.size, Math.max(0, y));
        this.rect.x = x;
        this.rect.y = y;
      } else {
        this._resizeFromHandle(dragMode, dx, dy, start.rect);
      }
      this._render();
      this._emit();
    };

    const pointerUp = () => {
      dragMode = null;
      window.removeEventListener("pointermove", pointerMove);
      window.removeEventListener("pointerup", pointerUp);
    };

    this.box.addEventListener("pointerdown", (e) => {
      if (e.target.classList.contains("crop-handle")) return;
      pointerDown(e, "move");
    });
    this.handles.forEach((h) => {
      h.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        pointerDown(e, h.dataset.handle);
      });
    });
  }

  _resizeFromHandle(handle, dx, dy, startRect) {
    const { x, y, size } = startRect;
    const isNorth = handle[0] === "n";
    const isWest = handle[1] === "w";

    const anchorX = isWest ? x + size : x;
    const anchorY = isNorth ? y + size : y;
    const cornerX = (isWest ? x : x + size) + dx;
    const cornerY = (isNorth ? y : y + size) + dy;

    let newSize = Math.max(Math.abs(cornerX - anchorX), Math.abs(cornerY - anchorY));

    const maxSizeX = isWest ? anchorX : this.displayW - anchorX;
    const maxSizeY = isNorth ? anchorY : this.displayH - anchorY;
    newSize = Math.min(newSize, maxSizeX, maxSizeY);
    newSize = Math.max(newSize, 20);

    this.rect = {
      x: isWest ? anchorX - newSize : anchorX,
      y: isNorth ? anchorY - newSize : anchorY,
      size: newSize,
    };
  }
}

import { XMLParser } from "fast-xml-parser";

export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface Primitive {
  type: "rect" | "line" | "circle" | "ellipse" | "polygon" | "polyline" | "path" | "text";
  tag: string;
  attributes: Record<string, string>;
  role?: string;
  figure?: string;
  box: Box;
  stroke?: string;
  fill?: string;
  strokeWidthMm?: number;
  fontSizeMm?: number;
  text?: string;
}

export interface ParsedDrawing {
  widthMm: number;
  heightMm: number;
  unitScaleMm: number;
  primitives: Primitive[];
  unsupported: string[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  parseTagValue: false,
  trimValues: true,
  preserveOrder: false,
});

const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function multiply(left: Matrix, right: Matrix): Matrix {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f,
  };
}

export function applyMatrix(matrix: Matrix, x: number, y: number): [number, number] {
  return [matrix.a * x + matrix.c * y + matrix.e, matrix.b * x + matrix.d * y + matrix.f];
}

/** Parse a transform attribute. Unsupported functions are reported, not guessed. */
export function parseTransform(value: string | undefined, unsupported: string[]): Matrix {
  if (!value) return IDENTITY;
  let matrix = IDENTITY;
  const pattern = /(translate|scale|matrix|rotate)\s*\(([^)]*)\)/g;
  for (const match of value.matchAll(pattern)) {
    const name = match[1];
    const args = (match[2] ?? "")
      .split(/[\s,]+/)
      .map((entry) => Number(entry))
      .filter((entry) => Number.isFinite(entry));
    if (name === "translate") {
      matrix = multiply(matrix, { ...IDENTITY, e: args[0] ?? 0, f: args[1] ?? 0 });
    } else if (name === "scale") {
      const sx = args[0] ?? 1;
      const sy = args[1] ?? sx;
      matrix = multiply(matrix, { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 });
    } else if (name === "matrix" && args.length === 6) {
      const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = args;
      matrix = multiply(matrix, { a, b, c, d, e, f });
    } else if (name === "rotate") {
      const angle = ((args[0] ?? 0) * Math.PI) / 180;
      const cx = args[1] ?? 0;
      const cy = args[2] ?? 0;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const rotation: Matrix = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
      const toOrigin: Matrix = { ...IDENTITY, e: -cx, f: -cy };
      const back: Matrix = { ...IDENTITY, e: cx, f: cy };
      matrix = multiply(matrix, multiply(back, multiply(rotation, toOrigin)));
    } else if (name) {
      unsupported.push(`transform:${name}`);
    }
  }
  return matrix;
}

function unitToMm(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const match = value.trim().match(/^([\d.]+)\s*([a-z%]*)$/i);
  if (!match) return fallback;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "").toLowerCase();
  if (!Number.isFinite(amount)) return fallback;
  switch (unit) {
    case "mm":
      return amount;
    case "cm":
      return amount * 10;
    case "in":
      return amount * 25.4;
    case "pt":
      return amount * 0.3528;
    case "pc":
      return amount * 4.2333;
    case "px":
    case "":
      return amount * 0.2646;
    default:
      return fallback;
  }
}

function number(value: string | undefined, fallback = 0): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boxOfPoints(points: Array<[number, number]>): Box {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
}

function pathPoints(d: string): { points: Array<[number, number]>; approximated: boolean } {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  const points: Array<[number, number]> = [];
  let index = 0;
  let command = "";
  let current: [number, number] = [0, 0];
  let start: [number, number] = [0, 0];
  let approximated = false;

  const read = (): number => Number(tokens[index++] ?? 0);
  const isCommand = (token: string | undefined): boolean => Boolean(token && /[a-zA-Z]/.test(token));

  while (index < tokens.length) {
    if (isCommand(tokens[index])) command = tokens[index++] ?? command;
    if (!command) break;
    const relative = command === command.toLowerCase();
    const origin: [number, number] = relative ? current : [0, 0];

    switch (command.toUpperCase()) {
      case "M": {
        const next: [number, number] = [origin[0] + read(), origin[1] + read()];
        current = next;
        start = next;
        points.push(next);
        command = relative ? "l" : "L";
        break;
      }
      case "L": {
        current = [origin[0] + read(), origin[1] + read()];
        points.push(current);
        break;
      }
      case "H": {
        current = [origin[0] + read(), current[1]];
        points.push(current);
        break;
      }
      case "V": {
        current = [current[0], origin[1] + read()];
        points.push(current);
        break;
      }
      case "C": {
        const c1: [number, number] = [origin[0] + read(), origin[1] + read()];
        const c2: [number, number] = [origin[0] + read(), origin[1] + read()];
        const end: [number, number] = [origin[0] + read(), origin[1] + read()];
        for (let step = 1; step <= 8; step += 1) {
          const t = step / 8;
          const mt = 1 - t;
          points.push([
            mt ** 3 * current[0] + 3 * mt ** 2 * t * c1[0] + 3 * mt * t ** 2 * c2[0] + t ** 3 * end[0],
            mt ** 3 * current[1] + 3 * mt ** 2 * t * c1[1] + 3 * mt * t ** 2 * c2[1] + t ** 3 * end[1],
          ]);
        }
        current = end;
        break;
      }
      case "Q": {
        const c: [number, number] = [origin[0] + read(), origin[1] + read()];
        const end: [number, number] = [origin[0] + read(), origin[1] + read()];
        for (let step = 1; step <= 8; step += 1) {
          const t = step / 8;
          const mt = 1 - t;
          points.push([
            mt ** 2 * current[0] + 2 * mt * t * c[0] + t ** 2 * end[0],
            mt ** 2 * current[1] + 2 * mt * t * c[1] + t ** 2 * end[1],
          ]);
        }
        current = end;
        break;
      }
      case "S": {
        approximated = true;
        const c2: [number, number] = [origin[0] + read(), origin[1] + read()];
        const end: [number, number] = [origin[0] + read(), origin[1] + read()];
        points.push(c2, end);
        current = end;
        break;
      }
      case "T": {
        approximated = true;
        current = [origin[0] + read(), origin[1] + read()];
        points.push(current);
        break;
      }
      case "A": {
        approximated = true;
        read();
        read();
        read();
        read();
        read();
        current = [origin[0] + read(), origin[1] + read()];
        points.push(current);
        break;
      }
      case "Z": {
        current = start;
        points.push(current);
        break;
      }
      default:
        approximated = true;
        command = "";
        break;
    }
  }
  return { points, approximated };
}

function textWidth(text: string, fontSizeMm: number): number {
  return text.length * fontSizeMm * 0.6;
}

export function parseSvg(svg: string): ParsedDrawing {
  const unsupported: string[] = [];
  const document = parser.parse(svg) as Record<string, unknown>;
  const root = document.svg as Record<string, unknown> | undefined;
  if (!root) throw new Error("not an SVG document: missing <svg> root");

  const widthAttr = typeof root["@width"] === "string" ? root["@width"] : undefined;
  const heightAttr = typeof root["@height"] === "string" ? root["@height"] : undefined;
  const viewBox = typeof root["@viewBox"] === "string" ? root["@viewBox"].split(/[\s,]+/).map(Number) : [];
  const widthMm = unitToMm(widthAttr, 210);
  const heightMm = unitToMm(heightAttr, 297);
  const vbWidth = viewBox[2] ?? widthMm;
  const unitScaleMm = vbWidth > 0 ? widthMm / vbWidth : 1;

  const primitives: Primitive[] = [];

  const visit = (node: unknown, parent: Matrix, inheritedRole?: string, inheritedFigure?: string): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, parent, inheritedRole, inheritedFigure);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [tag, raw] of Object.entries(node as Record<string, unknown>)) {
      if (tag === "#text") continue;
      const items = Array.isArray(raw) ? raw : [raw];
      for (const item of items) {
        if (item === null || typeof item !== "object") continue;
        const attrs = item as Record<string, unknown>;
        const attribute = (name: string): string | undefined =>
          typeof attrs[`@${name}`] === "string" ? (attrs[`@${name}`] as string) : undefined;
        const role = attribute("data-role") ?? inheritedRole;
        const matrix = multiply(parent, parseTransform(attribute("transform"), unsupported));

        const stroke = attribute("stroke");
        const fill = attribute("fill");
        const strokeWidthMm = number(attribute("stroke-width"), 1) * unitScaleMm;
        const fontSizeMm = number(attribute("font-size"), 12) * unitScaleMm;

        const push = (primitive: Primitive): void => {
          primitive.figure = attribute("data-figure") ?? inheritedFigure;
          primitives.push(primitive);
        };

        if (tag === "rect") {
          const x = number(attribute("x"));
          const y = number(attribute("y"));
          const w = number(attribute("width"));
          const h = number(attribute("height"));
          push({
            type: "rect",
            tag,
            attributes: toAttributes(attribute),
            role,
            box: boxOfPoints([applyMatrix(matrix, x, y), applyMatrix(matrix, x + w, y + h)]),
            stroke,
            fill,
            strokeWidthMm,
          });
        } else if (tag === "line") {
          const x1 = number(attribute("x1"));
          const y1 = number(attribute("y1"));
          const x2 = number(attribute("x2"));
          const y2 = number(attribute("y2"));
          push({
            type: "line",
            tag,
            attributes: toAttributes(attribute),
            role,
            box: boxOfPoints([applyMatrix(matrix, x1, y1), applyMatrix(matrix, x2, y2)]),
            stroke,
            fill,
            strokeWidthMm,
          });
        } else if (tag === "circle") {
          const cx = number(attribute("cx"));
          const cy = number(attribute("cy"));
          const r = number(attribute("r"));
          push({
            type: "circle",
            tag,
            attributes: toAttributes(attribute),
            role,
            box: boxOfPoints([
              applyMatrix(matrix, cx - r, cy - r),
              applyMatrix(matrix, cx + r, cy + r),
            ]),
            stroke,
            fill,
            strokeWidthMm,
          });
        } else if (tag === "ellipse") {
          const cx = number(attribute("cx"));
          const cy = number(attribute("cy"));
          const rx = number(attribute("rx"));
          const ry = number(attribute("ry"));
          push({
            type: "ellipse",
            tag,
            attributes: toAttributes(attribute),
            role,
            box: boxOfPoints([
              applyMatrix(matrix, cx - rx, cy - ry),
              applyMatrix(matrix, cx + rx, cy + ry),
            ]),
            stroke,
            fill,
            strokeWidthMm,
          });
        } else if (tag === "polygon" || tag === "polyline") {
          const points = (attribute("points") ?? "")
            .split(/[\s,]+/)
            .map(Number)
            .reduce<Array<[number, number]>>((acc, value, index, all) => {
              if (index % 2 === 0) acc.push([value, all[index + 1] ?? 0]);
              return acc;
            }, [])
            .map(([x, y]) => applyMatrix(matrix, x, y));
          if (points.length > 0) {
            push({
              type: tag,
              tag,
              attributes: toAttributes(attribute),
              role,
              box: boxOfPoints(points),
              stroke,
              fill,
              strokeWidthMm,
            });
          }
        } else if (tag === "path") {
          const { points, approximated } = pathPoints(attribute("d") ?? "");
          if (approximated) unsupported.push("path-command");
          const mapped = points.map(([x, y]) => applyMatrix(matrix, x, y));
          if (mapped.length > 0) {
            push({
              type: "path",
              tag,
              attributes: toAttributes(attribute),
              role,
              box: boxOfPoints(mapped),
              stroke,
              fill,
              strokeWidthMm,
            });
          }
        } else if (tag === "text") {
          const content = typeof attrs["#text"] === "string" ? attrs["#text"] : "";
          const x = number(attribute("x"));
          const y = number(attribute("y"));
          const anchor = attribute("text-anchor") ?? "start";
          const width = textWidth(content, fontSizeMm);
          const left = anchor === "middle" ? x - width / 2 : anchor === "end" ? x - width : x;
          const [x1, y1] = applyMatrix(matrix, left, y - fontSizeMm);
          const [x2, y2] = applyMatrix(matrix, left + width, y);
          push({
            type: "text",
            tag,
            attributes: toAttributes(attribute),
            role,
            box: boxOfPoints([
              [Math.min(x1, x2), Math.min(y1, y2)],
              [Math.max(x1, x2), Math.max(y1, y2)],
            ]),
            stroke,
            fill,
            fontSizeMm,
            text: content,
          });
        } else if (tag === "g" || tag === "svg") {
          // Container: recurse below with the composed transform.
        } else if (tag === "defs" || tag === "pattern" || tag === "clipPath" || tag === "style" || tag === "title" || tag === "desc" || tag === "metadata") {
          continue;
        } else {
          unsupported.push(`element:${tag}`);
        }

        for (const [childTag, childValue] of Object.entries(attrs)) {
          if (childTag.startsWith("@") || childTag === "#text") continue;
          visit({ [childTag]: childValue }, matrix, role, attribute("data-figure") ?? inheritedFigure);
        }
      }
    }
  };

  visit({ svg: root }, IDENTITY);

  return { widthMm, heightMm, unitScaleMm, primitives, unsupported: [...new Set(unsupported)] };
}

function toAttributes(getter: (name: string) => string | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  for (const name of [
    "stroke",
    "fill",
    "stroke-width",
    "font-size",
    "text-anchor",
    "data-role",
    "data-figure",
    "id",
    "class",
  ]) {
    const value = getter(name);
    if (value !== undefined) record[name] = value;
  }
  return record;
}

export function intersects(a: Box, b: Box): boolean {
  return a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
}

export function boxWidthMm(box: Box, unitScaleMm: number): number {
  return (box.x2 - box.x1) * unitScaleMm;
}

export function boxHeightMm(box: Box, unitScaleMm: number): number {
  return (box.y2 - box.y1) * unitScaleMm;
}

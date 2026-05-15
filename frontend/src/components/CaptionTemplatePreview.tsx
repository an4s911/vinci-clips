"use client";

import React from "react";

export type CaptionPreviewAspect = "portrait" | "square" | "landscape";

export interface CaptionPreviewLayout {
    fontSize: number;
    maxWordsPerPhrase: number;
    marginV: number;
    marginL: number;
    marginR: number;
    previewFontSize?: number;
}

export interface CaptionPreviewTemplate {
    fontName: string;
    fontColor: string;
    outlineColor: string;
    backColor?: string | null;
    outlineWidth: number;
    bold: boolean;
    italic?: boolean;
    underline?: boolean;
    shadow: boolean;
    shadowDepth: number;
    alignment?: number;
    scaleX: number;
    scaleY: number;
    spacing?: number;
    uppercase: boolean;
    borderStyle: number;
    preview?: {
        backgroundColor?: string;
        [key: string]: unknown;
    } | null;
    layouts: Record<CaptionPreviewAspect, CaptionPreviewLayout>;
}

const PREVIEW_SIZE: Record<CaptionPreviewAspect, { width: number; height: number }> = {
    portrait: { width: 160, height: 284 },
    square: { width: 220, height: 220 },
    landscape: { width: 320, height: 180 },
};

export function getCaptionPreviewBackground(template: CaptionPreviewTemplate): string {
    const backgroundColor = template.preview?.backgroundColor;
    if (!backgroundColor || backgroundColor === "transparent") return "#111111";
    return backgroundColor;
}

export function fontFamilyCSS(fontName: string): string {
    const lower = fontName.toLowerCase();
    if (lower.includes("mono") || lower === "courier") return `"${fontName}", monospace`;
    return `"${fontName}", sans-serif`;
}

function getCaptionCSS(
    template: CaptionPreviewTemplate,
    aspect: CaptionPreviewAspect,
    textScale: number
): React.CSSProperties {
    const layout = template.layouts[aspect];
    const alignment = template.alignment ?? 2;
    const col = (alignment - 1) % 3;
    const row = Math.floor((alignment - 1) / 3);
    const sx = template.scaleX ?? 1;
    const sy = template.scaleY ?? 1;
    const shadowDepth = template.shadowDepth ?? 1;
    const shadow = template.shadow
        ? `${shadowDepth * textScale}px ${shadowDepth * textScale}px ${shadowDepth * 2 * textScale}px rgba(0,0,0,0.8)`
        : "none";
    const isOpaqueBox = template.borderStyle === 3;
    const bg = isOpaqueBox && template.backColor ? template.backColor : "transparent";
    const hasOutline = !isOpaqueBox && template.outlineWidth > 0;
    const boxPadding = isOpaqueBox ? template.outlineWidth * textScale : 0;
    const fontSize = Math.max(8 * textScale, Math.round(layout.fontSize * 0.5 * textScale));
    const textAlign: "left" | "center" | "right" = col === 0 ? "left" : col === 2 ? "right" : "center";

    const pos: React.CSSProperties = { position: "absolute" };
    if (col === 0) pos.left = layout.marginL * textScale;
    else if (col === 2) pos.right = layout.marginR * textScale;
    else pos.left = "50%";

    if (row === 0) pos.bottom = layout.marginV * textScale;
    else if (row === 2) pos.top = layout.marginV * textScale;
    else pos.top = "50%";

    const tx = col === 1 ? "-50%" : "0%";
    const ty = row === 1 ? "-50%" : "0%";
    const transform = (tx !== "0%" || ty !== "0%")
        ? `translate(${tx}, ${ty}) scale(${sx}, ${sy})`
        : `scale(${sx}, ${sy})`;

    const toH = col === 0 ? "left" : col === 2 ? "right" : "center";
    const toV = row === 0 ? "bottom" : row === 2 ? "top" : "center";

    return {
        ...pos,
        transform,
        transformOrigin: `${toH} ${toV}`,
        textAlign,
        fontSize,
        fontWeight: template.bold ? 800 : 400,
        fontStyle: template.italic ? "italic" : "normal",
        textDecoration: template.underline ? "underline" : "none",
        fontFamily: fontFamilyCSS(template.fontName),
        color: template.fontColor,
        background: bg,
        padding: boxPadding ? `${boxPadding}px ${boxPadding * 1.5}px` : undefined,
        borderRadius: boxPadding ? 3 : undefined,
        textShadow: shadow,
        textTransform: template.uppercase ? "uppercase" : "none",
        letterSpacing: template.spacing ? template.spacing * textScale : 0,
        WebkitTextStroke: hasOutline ? `${template.outlineWidth * textScale}px ${template.outlineColor}` : undefined,
        paintOrder: "stroke fill",
        lineHeight: 1.2,
        whiteSpace: "nowrap",
        maxWidth: "86%",
    } as React.CSSProperties;
}

export function CaptionTemplatePreview({
    template,
    aspect = "portrait",
    text = "SAMPLE TEXT",
    className,
    style,
}: {
    template: CaptionPreviewTemplate;
    aspect?: CaptionPreviewAspect;
    text?: string;
    className?: string;
    style?: React.CSSProperties;
}) {
    const size = PREVIEW_SIZE[aspect];
    const height = typeof style?.height === "number" ? style.height : size.height;
    const textScale = height / size.height;
    const captionCSS = getCaptionCSS(template, aspect, textScale);

    return (
        <div
            className={`relative overflow-hidden ${className || ""}`}
            style={{
                aspectRatio: `${size.width} / ${size.height}`,
                background: getCaptionPreviewBackground(template),
                ...style,
            }}
        >
            <div style={captionCSS}>{text || "SAMPLE TEXT"}</div>
        </div>
    );
}

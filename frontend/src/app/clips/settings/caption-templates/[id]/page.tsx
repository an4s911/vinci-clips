"use client";

import React, { useEffect, useState, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import axios from "axios";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
    ChevronLeft, Save, Loader2, Play, RotateCcw, Smartphone, Square, Monitor
} from "lucide-react";
import {
    CaptionTemplatePreview,
    getCaptionPreviewBackground,
} from "@/components/CaptionTemplatePreview";

const API_URL = process.env.NEXT_PUBLIC_API_URL;

interface LayoutStyle {
    fontSize: number;
    maxWordsPerPhrase: number;
    marginV: number;
    marginL: number;
    marginR: number;
    previewFontSize: number;
}

interface HookOverrides {
    enabled: boolean;
    fontSizeMultiplier: number;
    position: "top" | "center" | "bottom";
    marginV: number;
    color?: string;
    scaleY?: number;
}

interface CaptionTemplate {
    id: string;
    name: string;
    description: string;
    isSeeded: boolean;
    fontName: string;
    fontColor: string;
    outlineColor: string;
    backColor: string;
    outlineWidth: number;
    shadow: boolean;
    shadowDepth: number;
    bold: boolean;
    italic: boolean;
    underline: boolean;
    alignment: number;
    scaleX: number;  // 0-1 fraction (1.0 = 100% = normal)
    scaleY: number;  // 0-1 fraction (1.0 = 100% = normal)
    spacing: number;
    uppercase: boolean;
    borderStyle: number;
    preview: { backgroundColor?: string };
    layouts: { portrait: LayoutStyle; square: LayoutStyle; landscape: LayoutStyle };
    hookOverrides: HookOverrides;
}

const DEFAULT_TEMPLATE: Omit<CaptionTemplate, "id" | "isSeeded"> = {
    name: "New Template",
    description: "",
    fontName: "DejaVu Sans",
    fontColor: "#ffffff",
    outlineColor: "#000000",
    backColor: "",
    outlineWidth: 1,
    shadow: false,
    shadowDepth: 1,
    bold: true,
    italic: false,
    underline: false,
    alignment: 2,
    scaleX: 1,
    scaleY: 1,
    spacing: 0,
    uppercase: true,
    borderStyle: 1,
    preview: { backgroundColor: "#111111" },
    layouts: {
        portrait: { fontSize: 20, maxWordsPerPhrase: 2, marginV: 30, marginL: 60, marginR: 60, previewFontSize: 12 },
        square: { fontSize: 20, maxWordsPerPhrase: 3, marginV: 25, marginL: 50, marginR: 50, previewFontSize: 14 },
        landscape: { fontSize: 18, maxWordsPerPhrase: 4, marginV: 20, marginL: 40, marginR: 40, previewFontSize: 12 },
    },
    hookOverrides: {
        enabled: true,
        fontSizeMultiplier: 1.08,
        position: "top",
        marginV: 50,
    },
};

const FONTS = [
    "DejaVu Sans", "DejaVu Sans Mono", "Montserrat", "Poppins",
    "Bebas Neue", "Oswald", "Roboto", "Anton", "Inter",
];

const ALIGNMENTS = [
    { value: 7, label: "TL" }, { value: 8, label: "TC" }, { value: 9, label: "TR" },
    { value: 4, label: "ML" }, { value: 5, label: "MC" }, { value: 6, label: "MR" },
    { value: 1, label: "BL" }, { value: 2, label: "BC" }, { value: 3, label: "BR" },
];

const ASPECT_OPTIONS = [
    { id: "portrait", label: "9:16", icon: <Smartphone className="h-3 w-3" /> },
    { id: "square", label: "1:1", icon: <Square className="h-3 w-3" /> },
    { id: "landscape", label: "16:9", icon: <Monitor className="h-3 w-3" /> },
] as const;

type AspectId = typeof ASPECT_OPTIONS[number]["id"];

function fontFamilyCSS(fontName: string): string {
    const lower = fontName.toLowerCase();
    if (lower.includes("mono") || lower === "courier") return `"${fontName}", monospace`;
    return `"${fontName}", sans-serif`;
}

function computeCaptionCSS(template: CaptionTemplate, layout: LayoutStyle): React.CSSProperties {
    const alignment = template.alignment ?? 2;
    // ASS numpad: 1=BL 2=BC 3=BR, 4=ML 5=MC 6=MR, 7=TL 8=TC 9=TR
    const col = (alignment - 1) % 3;           // 0=left, 1=center, 2=right
    const row = Math.floor((alignment - 1) / 3); // 0=bottom, 1=middle, 2=top

    const sx = template.scaleX ?? 1;
    const sy = template.scaleY ?? 1;
    const shadowDepth = template.shadowDepth ?? 1;
    const shadow = template.shadow
        ? `${shadowDepth}px ${shadowDepth}px ${shadowDepth * 2}px rgba(0,0,0,0.8)`
        : "none";
    const bg = template.borderStyle === 3 && template.backColor ? template.backColor : "transparent";
    const hasOutline = template.outlineWidth > 0;
    const previewFontSize = Math.max(8, Math.round(layout.fontSize * 0.5));
    const textAlign: 'left' | 'center' | 'right' = col === 0 ? 'left' : col === 2 ? 'right' : 'center';

    const pos: React.CSSProperties = { position: 'absolute' };
    if (col === 0) pos.left = layout.marginL;
    else if (col === 2) pos.right = layout.marginR;
    else pos.left = '50%';

    if (row === 0) pos.bottom = layout.marginV;
    else if (row === 2) pos.top = layout.marginV;
    else pos.top = '50%';

    const tx = col === 1 ? '-50%' : '0%';
    const ty = row === 1 ? '-50%' : '0%';
    const transform = (tx !== '0%' || ty !== '0%')
        ? `translate(${tx}, ${ty}) scale(${sx}, ${sy})`
        : `scale(${sx}, ${sy})`;

    const toH = col === 0 ? 'left' : col === 2 ? 'right' : 'center';
    const toV = row === 0 ? 'bottom' : row === 2 ? 'top' : 'center';

    return {
        ...pos,
        transform,
        transformOrigin: `${toH} ${toV}`,
        textAlign,
        fontSize: previewFontSize,
        fontWeight: template.bold ? 800 : 400,
        fontStyle: template.italic ? "italic" : "normal",
        textDecoration: template.underline ? "underline" : "none",
        fontFamily: fontFamilyCSS(template.fontName),
        color: template.fontColor,
        background: bg,
        textShadow: shadow,
        textTransform: template.uppercase ? "uppercase" : "none",
        WebkitTextStroke: hasOutline ? `${template.outlineWidth}px ${template.outlineColor}` : undefined,
        paintOrder: "stroke fill",
        lineHeight: 1.2,
        whiteSpace: "nowrap",
        zIndex: 10,
    } as React.CSSProperties;
}

function NumberInput({ label, value, onChange, min, max, step = 1 }: {
    label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number;
}) {
    return (
        <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">{label}</Label>
            <Input
                type="number" value={value} min={min} max={max} step={step}
                onChange={(e) => onChange(Number(e.target.value))}
                className="h-8 text-sm"
            />
        </div>
    );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
    return (
        <label className="flex items-center gap-2 cursor-pointer select-none">
            <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-blue-600" />
            <span className="text-sm">{label}</span>
        </label>
    );
}

function ColorInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
    return (
        <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">{label}</Label>
            <div className="flex gap-2">
                <input type="color" value={value || "#000000"} onChange={(e) => onChange(e.target.value)}
                    className="h-8 w-10 rounded border cursor-pointer p-0.5" />
                <Input value={value} onChange={(e) => onChange(e.target.value)}
                    placeholder="#000000" className="h-8 text-sm font-mono" />
            </div>
        </div>
    );
}

export default function CaptionTemplateEditorPage() {
    const params = useParams();
    const router = useRouter();
    const isNew = params.id === "new";

    const [template, setTemplate] = useState<CaptionTemplate>({
        ...DEFAULT_TEMPLATE,
        id: "new",
        isSeeded: false,
    });
    const [loading, setLoading] = useState(!isNew);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [activeLayout, setActiveLayout] = useState<"portrait" | "square" | "landscape">("portrait");
    const [previewAspect, setPreviewAspect] = useState<AspectId>("portrait");
    const [previewText, setPreviewText] = useState("HELLO WORLD");
    const [renderingPreview, setRenderingPreview] = useState(false);
    const [previewVideoUrl, setPreviewVideoUrl] = useState<string | null>(null);
    const [activeSection, setActiveSection] = useState<string>("typography");
    const videoRef = useRef<HTMLVideoElement>(null);

    useEffect(() => {
        if (isNew) return;
        axios.get(`${API_URL}/clips/caption-templates/${params.id}`)
            .then((res) => setTemplate(res.data.template))
            .catch((e) => setError(e.response?.data?.error || "Failed to load template"))
            .finally(() => setLoading(false));
    }, [params.id, isNew]);

    const set = (key: keyof CaptionTemplate, value: any) =>
        setTemplate((prev) => ({ ...prev, [key]: value }));

    const setLayout = (aspect: "portrait" | "square" | "landscape", key: keyof LayoutStyle, value: number) =>
        setTemplate((prev) => ({
            ...prev,
            layouts: { ...prev.layouts, [aspect]: { ...prev.layouts[aspect], [key]: value } },
        }));

    const setHook = (key: keyof HookOverrides, value: any) =>
        setTemplate((prev) => ({ ...prev, hookOverrides: { ...prev.hookOverrides, [key]: value } }));

    const setPreviewBgColor = (value: string) =>
        setTemplate((prev) => ({
            ...prev,
            preview: { ...(prev.preview || {}), backgroundColor: value },
        }));

    const save = async () => {
        setSaving(true);
        setError("");
        try {
            if (isNew) {
                const res = await axios.post(`${API_URL}/clips/caption-templates`, template);
                router.push(`/clips/settings/caption-templates/${res.data.template.id}`);
            } else {
                const res = await axios.put(`${API_URL}/clips/caption-templates/${template.id}`, template);
                setTemplate(res.data.template);
            }
        } catch (e: any) {
            setError(e.response?.data?.error || "Failed to save");
        } finally {
            setSaving(false);
        }
    };

    const renderPreview = async () => {
        setRenderingPreview(true);
        setPreviewVideoUrl(null);
        try {
            const res = await axios.post(`${API_URL}/clips/caption-templates/preview`, {
                template,
                sampleText: previewText || "HELLO WORLD",
                aspect: previewAspect,
                bgColor: getCaptionPreviewBackground(template),
            });
            setPreviewVideoUrl(`${API_URL}${res.data.previewUrl}`);
            setTimeout(() => videoRef.current?.play(), 200);
        } catch (e: any) {
            setError(e.response?.data?.error || "Preview render failed");
        } finally {
            setRenderingPreview(false);
        }
    };

    const previewBgColor = getCaptionPreviewBackground(template);

    const aspectStyle = previewAspect === "landscape"
        ? { width: 320, height: 180 }
        : previewAspect === "square"
            ? { width: 220, height: 220 }
            : { width: 160, height: 284 };

    if (loading) return <div className="flex h-screen items-center justify-center"><Loader2 className="animate-spin" /></div>;

    const sections = ["typography", "colors", "position", "layouts", "hook"] as const;

    return (
        <main className="container mx-auto max-w-6xl p-6 space-y-6">
            {/* Header */}
            <div className="flex items-center gap-4">
                <Link href="/clips/settings/caption-templates">
                    <Button variant="ghost" size="sm">
                        <ChevronLeft className="h-4 w-4 mr-1" />
                        Templates
                    </Button>
                </Link>
                <div className="flex-1">
                    <Input
                        value={template.name}
                        onChange={(e) => set("name", e.target.value)}
                        className="text-lg font-semibold border-0 border-b rounded-none px-0 focus-visible:ring-0"
                        placeholder="Template name"
                    />
                </div>
                {template.isSeeded && <Badge variant="secondary">Default</Badge>}
                <Button onClick={save} disabled={saving}>
                    {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
                    Save
                </Button>
            </div>

            {error && (
                <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">{error}</div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-6">
                {/* Left: form */}
                <div className="space-y-4">
                    <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Description</Label>
                        <Input value={template.description} onChange={(e) => set("description", e.target.value)}
                            placeholder="Optional description" className="h-8 text-sm" />
                    </div>

                    <div className="flex gap-1 flex-wrap border-b pb-2">
                        {sections.map((s) => (
                            <button key={s} onClick={() => setActiveSection(s)}
                                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${activeSection === s ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                                {s.charAt(0).toUpperCase() + s.slice(1)}
                            </button>
                        ))}
                    </div>

                    {/* Typography */}
                    {activeSection === "typography" && (
                        <Card>
                            <CardHeader><CardTitle className="text-sm">Typography</CardTitle></CardHeader>
                            <CardContent className="space-y-4">
                                <div className="space-y-1">
                                    <Label className="text-xs text-muted-foreground">Font Family</Label>
                                    <select value={template.fontName} onChange={(e) => set("fontName", e.target.value)}
                                        className="w-full h-8 rounded-md border border-input bg-background px-2 text-sm">
                                        {FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
                                    </select>
                                </div>
                                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                                    <Toggle label="Bold" checked={template.bold} onChange={(v) => set("bold", v)} />
                                    <Toggle label="Italic" checked={template.italic} onChange={(v) => set("italic", v)} />
                                    <Toggle label="Underline" checked={template.underline} onChange={(v) => set("underline", v)} />
                                    <Toggle label="Uppercase" checked={template.uppercase} onChange={(v) => set("uppercase", v)} />
                                </div>
                                <div className="grid grid-cols-3 gap-3">
                                    <NumberInput
                                        label="Scale X (%)"
                                        value={Math.round((template.scaleX ?? 1) * 100)}
                                        onChange={(v) => set("scaleX", v / 100)}
                                        min={10} max={300}
                                    />
                                    <NumberInput
                                        label="Scale Y (%)"
                                        value={Math.round((template.scaleY ?? 1) * 100)}
                                        onChange={(v) => set("scaleY", v / 100)}
                                        min={10} max={300}
                                    />
                                    <NumberInput label="Spacing (px)" value={template.spacing} onChange={(v) => set("spacing", v)} min={0} max={20} step={0.5} />
                                </div>
                            </CardContent>
                        </Card>
                    )}

                    {/* Colors */}
                    {activeSection === "colors" && (
                        <Card>
                            <CardHeader><CardTitle className="text-sm">Colors & Outline</CardTitle></CardHeader>
                            <CardContent className="space-y-4">
                                <div className="grid grid-cols-2 gap-4">
                                    <ColorInput label="Text Color" value={template.fontColor} onChange={(v) => set("fontColor", v)} />
                                    <ColorInput label="Outline Color" value={template.outlineColor} onChange={(v) => set("outlineColor", v)} />
                                </div>
                                <NumberInput label="Outline Width" value={template.outlineWidth} onChange={(v) => set("outlineWidth", v)} min={0} max={10} step={0.1} />
                                <div className="space-y-1">
                                    <Label className="text-xs text-muted-foreground">Border Style</Label>
                                    <div className="flex gap-2">
                                        {[{ v: 1, label: "Outline" }, { v: 3, label: "Opaque Box" }].map(({ v, label }) => (
                                            <button key={v} onClick={() => set("borderStyle", v)}
                                                className={`flex-1 py-1.5 text-xs rounded-md border transition-colors ${template.borderStyle === v ? "bg-primary text-primary-foreground border-primary" : "border-input hover:border-gray-400"}`}>
                                                {label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                {template.borderStyle === 3 && (
                                    <ColorInput label="Back Color (box)" value={template.backColor || "#000000"} onChange={(v) => set("backColor", v)} />
                                )}
                                <div className="space-y-3">
                                    <Toggle label="Shadow" checked={template.shadow} onChange={(v) => set("shadow", v)} />
                                    {template.shadow && (
                                        <NumberInput label="Shadow Depth" value={template.shadowDepth} onChange={(v) => set("shadowDepth", v)} min={0} max={5} step={0.5} />
                                    )}
                                </div>
                            </CardContent>
                        </Card>
                    )}

                    {/* Position */}
                    {activeSection === "position" && (
                        <Card>
                            <CardHeader><CardTitle className="text-sm">Alignment</CardTitle></CardHeader>
                            <CardContent>
                                <div className="space-y-1">
                                    <Label className="text-xs text-muted-foreground">Numpad layout (7=top-left, 2=bottom-center)</Label>
                                    <div className="grid grid-cols-3 gap-2 max-w-[210px]">
                                        {ALIGNMENTS.map(({ value, label }) => (
                                            <button key={value} onClick={() => set("alignment", value)}
                                                className={`py-2 px-3 text-sm font-medium rounded border transition-colors ${template.alignment === value ? "bg-primary text-primary-foreground border-primary" : "border-input hover:border-gray-400"}`}>
                                                {label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                    )}

                    {/* Per-layout */}
                    {activeSection === "layouts" && (
                        <Card>
                            <CardHeader><CardTitle className="text-sm">Per-Aspect Layouts</CardTitle></CardHeader>
                            <CardContent className="space-y-4">
                                <div className="flex gap-1 border-b pb-2">
                                    {(["portrait", "square", "landscape"] as const).map((a) => (
                                        <button key={a} onClick={() => setActiveLayout(a)}
                                            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${activeLayout === a ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                                            {a === "portrait" ? "9:16" : a === "square" ? "1:1" : "16:9"}
                                        </button>
                                    ))}
                                </div>
                                {(["portrait", "square", "landscape"] as const).map((a) =>
                                    activeLayout === a ? (
                                        <div key={a} className="space-y-3">
                                            <div className="grid grid-cols-2 gap-3">
                                                <NumberInput label="Font Size (pt)" value={template.layouts[a].fontSize}
                                                    onChange={(v) => setLayout(a, "fontSize", v)} min={8} max={72} />
                                                <NumberInput label="Max Words" value={template.layouts[a].maxWordsPerPhrase}
                                                    onChange={(v) => setLayout(a, "maxWordsPerPhrase", v)} min={1} max={10} />
                                            </div>
                                            <div className="grid grid-cols-3 gap-3">
                                                <NumberInput label="Margin V" value={template.layouts[a].marginV}
                                                    onChange={(v) => setLayout(a, "marginV", v)} min={0} max={500} />
                                                <NumberInput label="Margin L" value={template.layouts[a].marginL}
                                                    onChange={(v) => setLayout(a, "marginL", v)} min={0} max={500} />
                                                <NumberInput label="Margin R" value={template.layouts[a].marginR}
                                                    onChange={(v) => setLayout(a, "marginR", v)} min={0} max={500} />
                                            </div>
                                        </div>
                                    ) : null
                                )}
                            </CardContent>
                        </Card>
                    )}

                    {/* Hook overrides */}
                    {activeSection === "hook" && (
                        <Card>
                            <CardHeader><CardTitle className="text-sm">Hook Overrides</CardTitle></CardHeader>
                            <CardContent className="space-y-4">
                                <Toggle label="Enable hook rendering" checked={template.hookOverrides.enabled}
                                    onChange={(v) => setHook("enabled", v)} />
                                <div className="grid grid-cols-2 gap-3">
                                    <NumberInput label="Font Size Multiplier" value={template.hookOverrides.fontSizeMultiplier}
                                        onChange={(v) => setHook("fontSizeMultiplier", v)} min={0.5} max={3} step={0.05} />
                                    <NumberInput label="Margin V" value={template.hookOverrides.marginV}
                                        onChange={(v) => setHook("marginV", v)} min={0} max={500} />
                                </div>
                                <div className="space-y-1">
                                    <Label className="text-xs text-muted-foreground">Position</Label>
                                    <div className="flex gap-2">
                                        {(["top", "center", "bottom"] as const).map((pos) => (
                                            <button key={pos} onClick={() => setHook("position", pos)}
                                                className={`flex-1 py-1.5 text-xs rounded-md border capitalize transition-colors ${template.hookOverrides.position === pos ? "bg-primary text-primary-foreground border-primary" : "border-input hover:border-gray-400"}`}>
                                                {pos}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <div className="space-y-1">
                                    <Label className="text-xs text-muted-foreground">Color Override (empty = use text color)</Label>
                                    <div className="flex gap-2">
                                        <input type="color" value={template.hookOverrides.color || template.fontColor}
                                            onChange={(e) => setHook("color", e.target.value)}
                                            className="h-8 w-10 rounded border cursor-pointer p-0.5" />
                                        <Input value={template.hookOverrides.color || ""}
                                            onChange={(e) => setHook("color", e.target.value || undefined)}
                                            placeholder="(same as text color)" className="h-8 text-sm font-mono" />
                                        {template.hookOverrides.color && (
                                            <Button size="sm" variant="ghost" onClick={() => setHook("color", undefined)}>
                                                <RotateCcw className="h-3 w-3" />
                                            </Button>
                                        )}
                                    </div>
                                </div>
                                <NumberInput
                                    label="Scale Y Override (%)"
                                    value={Math.round((template.hookOverrides.scaleY ?? template.scaleY ?? 1) * 100)}
                                    onChange={(v) => setHook("scaleY", v / 100)}
                                    min={10} max={300}
                                />
                            </CardContent>
                        </Card>
                    )}
                </div>

                {/* Right: preview */}
                <div className="space-y-4">
                    <Card className="sticky top-6">
                        <CardHeader><CardTitle className="text-sm">Preview</CardTitle></CardHeader>
                        <CardContent className="space-y-3">
                            <div className="flex gap-1">
                                {ASPECT_OPTIONS.map((opt) => (
                                    <button key={opt.id} onClick={() => setPreviewAspect(opt.id)}
                                        className={`flex-1 flex items-center justify-center gap-1 py-1 text-xs rounded-md border transition-colors ${previewAspect === opt.id ? "bg-primary text-primary-foreground border-primary" : "border-input hover:border-gray-400"}`}>
                                        {opt.icon} {opt.label}
                                    </button>
                                ))}
                            </div>

                            <div className="flex justify-center">
                                <CaptionTemplatePreview
                                    template={template}
                                    aspect={previewAspect}
                                    text={previewText || "HELLO WORLD"}
                                    className="rounded flex-shrink-0"
                                    style={aspectStyle}
                                />
                            </div>

                            <div className="flex items-center gap-2">
                                <Label className="text-xs text-muted-foreground shrink-0">Preview bg</Label>
                                <input type="color" value={previewBgColor}
                                    onChange={(e) => setPreviewBgColor(e.target.value)}
                                    className="h-7 w-9 rounded border cursor-pointer p-0.5" />
                                <Input value={previewBgColor} onChange={(e) => setPreviewBgColor(e.target.value)}
                                    className="h-7 text-xs font-mono" />
                            </div>

                            <div className="space-y-1">
                                <Label className="text-xs text-muted-foreground">Sample text</Label>
                                <Input value={previewText} onChange={(e) => setPreviewText(e.target.value)}
                                    placeholder="HELLO WORLD" className="h-8 text-sm" />
                            </div>

                            <Button variant="outline" className="w-full text-xs" onClick={renderPreview}
                                disabled={renderingPreview}>
                                {renderingPreview
                                    ? <><Loader2 className="h-3 w-3 mr-1 animate-spin" />Rendering...</>
                                    : <><Play className="h-3 w-3 mr-1" />Render with ffmpeg</>}
                            </Button>

                            {previewVideoUrl && (
                                <video ref={videoRef} src={previewVideoUrl} controls loop
                                    className="w-full rounded border" />
                            )}
                        </CardContent>
                    </Card>
                </div>
            </div>
        </main>
    );
}

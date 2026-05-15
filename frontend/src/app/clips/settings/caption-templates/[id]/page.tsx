"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import axios from "axios";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    Check, ChevronLeft, Save, Loader2, Play, Smartphone, Square, Monitor
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

interface CaptionTemplate {
    id: string;
    name: string;
    description: string;
    isSeeded: boolean;
    usage: "captions" | "hooks" | "both";
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
}

const DEFAULT_TEMPLATE: Omit<CaptionTemplate, "id" | "isSeeded"> = {
    name: "New Template",
    description: "",
    usage: "both",
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

const USAGE_OPTIONS = [
    { id: "captions", label: "Captions only" },
    { id: "hooks", label: "Hooks only" },
    { id: "both", label: "Captions + hooks" },
] as const;

function getErrorMessage(error: unknown, fallback: string) {
    return axios.isAxiosError<{ error?: string }>(error)
        ? error.response?.data?.error || fallback
        : fallback;
}

function getTemplateSnapshot(template: CaptionTemplate) {
    return JSON.stringify({
        name: template.name ?? "",
        description: template.description ?? "",
        usage: template.usage ?? "both",
        fontName: template.fontName ?? "DejaVu Sans",
        fontColor: template.fontColor ?? "#ffffff",
        outlineColor: template.outlineColor ?? "#000000",
        backColor: template.backColor ?? "",
        outlineWidth: template.outlineWidth ?? 1,
        shadow: template.shadow ?? false,
        shadowDepth: template.shadowDepth ?? 1,
        bold: template.bold ?? true,
        italic: template.italic ?? false,
        underline: template.underline ?? false,
        alignment: template.alignment ?? 2,
        scaleX: template.scaleX ?? 1,
        scaleY: template.scaleY ?? 1,
        spacing: template.spacing ?? 0,
        uppercase: template.uppercase ?? true,
        borderStyle: template.borderStyle ?? 1,
        preview: {
            backgroundColor: template.preview?.backgroundColor ?? "#111111",
        },
        layouts: {
            portrait: { ...template.layouts.portrait },
            square: { ...template.layouts.square },
            landscape: { ...template.layouts.landscape },
        },
    });
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
    const [savedSnapshot, setSavedSnapshot] = useState(() => getTemplateSnapshot({
        ...DEFAULT_TEMPLATE,
        id: "new",
        isSeeded: false,
    }));
    const [saveSucceeded, setSaveSucceeded] = useState(false);
    const [discardDialogOpen, setDiscardDialogOpen] = useState(false);
    const videoRef = useRef<HTMLVideoElement>(null);
    const allowNavigationRef = useRef(false);
    const guardEntryActiveRef = useRef(false);
    const pendingNavigationRef = useRef<{ type: "path"; href: string } | { type: "back" } | null>(null);

    const currentSnapshot = useMemo(() => getTemplateSnapshot(template), [template]);
    const isDirty = currentSnapshot !== savedSnapshot;

    useEffect(() => {
        if (isNew) return;
        axios.get(`${API_URL}/clips/caption-templates/${params.id}`)
            .then((res) => {
                const loadedTemplate = { ...res.data.template, usage: res.data.template.usage || "both" };
                setTemplate(loadedTemplate);
                setSavedSnapshot(getTemplateSnapshot(loadedTemplate));
            })
            .catch((e: unknown) => setError(getErrorMessage(e, "Failed to load template")))
            .finally(() => setLoading(false));
    }, [params.id, isNew]);

    useEffect(() => {
        if (isDirty) setSaveSucceeded(false);
    }, [isDirty]);

    useEffect(() => {
        if (!saveSucceeded) return;
        const timeout = window.setTimeout(() => setSaveSucceeded(false), 1500);
        return () => window.clearTimeout(timeout);
    }, [saveSucceeded]);

    useEffect(() => {
        if (!isDirty) return;

        const handleBeforeUnload = (event: BeforeUnloadEvent) => {
            event.preventDefault();
            event.returnValue = "";
        };

        window.addEventListener("beforeunload", handleBeforeUnload);
        return () => window.removeEventListener("beforeunload", handleBeforeUnload);
    }, [isDirty]);

    useEffect(() => {
        if (!isDirty) return;

        const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        if (!guardEntryActiveRef.current) {
            window.history.pushState({ captionTemplateGuard: true }, "", currentUrl);
            guardEntryActiveRef.current = true;
        }

        const handlePopState = () => {
            if (allowNavigationRef.current) return;
            window.history.pushState({ captionTemplateGuard: true }, "", currentUrl);
            guardEntryActiveRef.current = true;
            pendingNavigationRef.current = { type: "back" };
            setDiscardDialogOpen(true);
        };

        window.addEventListener("popstate", handlePopState);
        return () => window.removeEventListener("popstate", handlePopState);
    }, [isDirty]);

    useEffect(() => {
        if (isDirty || !guardEntryActiveRef.current || allowNavigationRef.current) return;

        const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        const handleGuardPop = () => {
            window.history.replaceState(null, "", currentUrl);
            guardEntryActiveRef.current = false;
            allowNavigationRef.current = false;
        };

        allowNavigationRef.current = true;
        window.addEventListener("popstate", handleGuardPop, { once: true });
        window.history.back();
        return () => window.removeEventListener("popstate", handleGuardPop);
    }, [isDirty]);

    const set = <K extends keyof CaptionTemplate>(key: K, value: CaptionTemplate[K]) =>
        setTemplate((prev) => ({ ...prev, [key]: value }));

    const setLayout = (aspect: "portrait" | "square" | "landscape", key: keyof LayoutStyle, value: number) =>
        setTemplate((prev) => ({
            ...prev,
            layouts: { ...prev.layouts, [aspect]: { ...prev.layouts[aspect], [key]: value } },
        }));

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
                const savedTemplate = { ...res.data.template, usage: res.data.template.usage || "both" };
                setTemplate(savedTemplate);
                setSavedSnapshot(getTemplateSnapshot(savedTemplate));
                setSaveSucceeded(true);
                allowNavigationRef.current = true;
                router.push(`/clips/settings/caption-templates/${res.data.template.id}`);
            } else {
                const res = await axios.put(`${API_URL}/clips/caption-templates/${template.id}`, template);
                const savedTemplate = { ...res.data.template, usage: res.data.template.usage || "both" };
                setTemplate(savedTemplate);
                setSavedSnapshot(getTemplateSnapshot(savedTemplate));
                setSaveSucceeded(true);
            }
        } catch (e: unknown) {
            setError(getErrorMessage(e, "Failed to save"));
        } finally {
            setSaving(false);
        }
    };

    const requestNavigation = useCallback((href: string) => {
        if (!isDirty) {
            router.push(href);
            return;
        }
        pendingNavigationRef.current = { type: "path", href };
        setDiscardDialogOpen(true);
    }, [isDirty, router]);

    const discardChangesAndNavigate = () => {
        const pendingNavigation = pendingNavigationRef.current;
        allowNavigationRef.current = true;
        setDiscardDialogOpen(false);
        if (pendingNavigation?.type === "path") {
            guardEntryActiveRef.current = false;
            router.push(pendingNavigation.href);
        } else if (pendingNavigation?.type === "back") {
            guardEntryActiveRef.current = false;
            window.history.go(-2);
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
        } catch (e: unknown) {
            setError(getErrorMessage(e, "Preview render failed"));
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

    const sections = ["typography", "colors", "position", "layouts"] as const;
    const saveButtonDisabled = !isDirty || saving;

    return (
        <main className="container mx-auto max-w-6xl p-6 space-y-6">
            {/* Header */}
            <div className="flex items-center gap-4">
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => requestNavigation("/clips/settings/caption-templates")}
                >
                    <ChevronLeft className="h-4 w-4 mr-1" />
                    Templates
                </Button>
                <div className="flex-1">
                    <Input
                        value={template.name}
                        onChange={(e) => set("name", e.target.value)}
                        className="text-lg font-semibold border-0 border-b rounded-none px-0 focus-visible:ring-0"
                        placeholder="Template name"
                    />
                </div>
                {template.isSeeded && <Badge variant="secondary">Default</Badge>}
                <Button onClick={save} disabled={saveButtonDisabled}>
                    {saving ? (
                        <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            Saving...
                        </>
                    ) : saveSucceeded ? (
                        <>
                            <Check className="h-4 w-4 mr-2" />
                            Saved
                        </>
                    ) : (
                        <>
                            <Save className="h-4 w-4 mr-2" />
                            Save
                        </>
                    )}
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

                    <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Use Template For</Label>
                        <div className="grid grid-cols-3 gap-2">
                            {USAGE_OPTIONS.map((option) => (
                                <button
                                    key={option.id}
                                    onClick={() => set("usage", option.id)}
                                    className={`rounded-md border px-3 py-2 text-xs font-medium transition-colors ${
                                        template.usage === option.id
                                            ? "border-primary bg-primary text-primary-foreground"
                                            : "border-input hover:border-gray-400"
                                    }`}
                                >
                                    {option.label}
                                </button>
                            ))}
                        </div>
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
                                <div className="space-y-1">
                                    <Label className="text-xs text-muted-foreground">Border Style</Label>
                                    <div className="flex gap-2">
                                        {[{ v: 1, label: "Outline" }, { v: 3, label: "Opaque Box" }].map(({ v, label }) => (
                                            <button key={v} onClick={() => {
                                                set("borderStyle", v);
                                                if (v === 3 && !template.backColor) set("backColor", "#000000");
                                            }}
                                                className={`flex-1 py-1.5 text-xs rounded-md border transition-colors ${template.borderStyle === v ? "bg-primary text-primary-foreground border-primary" : "border-input hover:border-gray-400"}`}>
                                                {label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                {template.borderStyle === 3 ? (
                                    <div className="grid grid-cols-2 gap-4">
                                        <ColorInput label="Box Color" value={template.backColor || "#000000"} onChange={(v) => set("backColor", v)} />
                                        <NumberInput label="Box Padding" value={template.outlineWidth} onChange={(v) => set("outlineWidth", v)} min={0} max={30} step={1} />
                                    </div>
                                ) : (
                                    <NumberInput label="Outline Width" value={template.outlineWidth} onChange={(v) => set("outlineWidth", v)} min={0} max={10} step={0.1} />
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

            <Dialog open={discardDialogOpen} onOpenChange={setDiscardDialogOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Discard unsaved changes?</DialogTitle>
                        <DialogDescription>
                            You have unsaved changes to this caption template. If you leave now, those changes will be lost.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setDiscardDialogOpen(false)}>
                            Stay
                        </Button>
                        <Button variant="destructive" onClick={discardChangesAndNavigate}>
                            Discard changes
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </main>
    );
}

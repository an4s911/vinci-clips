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
    Check, ChevronLeft, Save, Loader2, Play, Smartphone, Square, Monitor, Trash2, Info
} from "lucide-react";
import {
    CaptionTemplatePreview,
    getCaptionPreviewBackground,
} from "@/components/CaptionTemplatePreview";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

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
    const [confirmDelete, setConfirmDelete] = useState(false);
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

    useEffect(() => {
        if (!isDirty) return;
        const handleClick = (e: MouseEvent) => {
            const anchor = (e.target as Element).closest("a[href]") as HTMLAnchorElement | null;
            if (!anchor) return;
            const href = anchor.getAttribute("href");
            if (!href || href.startsWith("http") || href.startsWith("//") || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            requestNavigation(href);
        };
        document.addEventListener("click", handleClick, true);
        return () => document.removeEventListener("click", handleClick, true);
    }, [isDirty, requestNavigation]);

    const discardChangesAndNavigate = () => {
        const pendingNavigation = pendingNavigationRef.current;
        allowNavigationRef.current = true;
        setDiscardDialogOpen(false);
        // allowNavigationRef=true lets the pushState intercept pass through and self-restore
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
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            {/* Header */}
            <div className="flex items-center gap-4">
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => requestNavigation("/clips/settings/caption-templates")}
                    className="hover:bg-primary/10 hover:text-primary transition-colors"
                >
                    <ChevronLeft className="h-4 w-4 mr-1" />
                    Templates
                </Button>
                <div className="flex-1">
                    <Input
                        value={template.name}
                        onChange={(e) => set("name", e.target.value)}
                        className="text-lg font-bold border-0 border-b rounded-none px-0 focus-visible:ring-0 bg-transparent"
                        placeholder="Template name…"
                    />
                </div>
                {template.isSeeded && <Badge className="bg-primary/90">Default</Badge>}
                <div className="flex items-center gap-2">
                    {!isNew && (
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setConfirmDelete(true)}
                            className="text-red-600 border-red-600/20 hover:bg-red-600 hover:text-white transition-colors duration-200 px-4 h-10 font-bold shadow-sm"
                        >
                            <Trash2 className="h-4 w-4 mr-2" />
                            Delete
                        </Button>
                    )}
                    <Button onClick={save} disabled={saveButtonDisabled} className="shadow-lg shadow-primary/20">
                        {saving ? (
                            <>
                                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                Saving…
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
            </div>

            {error && (
                <div className="rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive flex items-center gap-2">
                    <Info className="h-4 w-4" />
                    {error}
                </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-6">
                {/* Left: form */}
                <div className="space-y-4">
                    <div className="space-y-1.5">
                        <Label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground ml-1">Description</Label>
                        <Input value={template.description} onChange={(e) => set("description", e.target.value)}
                            placeholder="Optional description…" className="h-10 text-sm bg-background/50 border-muted-foreground/10" />
                    </div>

                    <div className="space-y-2">
                        <Label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground ml-1">Use Template For</Label>
                        <div className="grid grid-cols-3 gap-2">
                            {USAGE_OPTIONS.map((option) => (
                                <button
                                    key={option.id}
                                    onClick={() => set("usage", option.id)}
                                    className={`rounded-xl border px-3 py-2.5 text-xs font-bold transition-all duration-200 ${
                                        template.usage === option.id
                                            ? "border-primary bg-primary text-primary-foreground shadow-md shadow-primary/10"
                                            : "border-muted-foreground/10 hover:border-primary/30 hover:bg-muted/50"
                                    }`}
                                >
                                    {option.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="flex gap-1 flex-wrap bg-muted/30 p-1 rounded-xl border border-muted-foreground/10">
                        {sections.map((s) => (
                            <button key={s} onClick={() => setActiveSection(s)}
                                className={`flex-1 px-3 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all duration-200 ${activeSection === s ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
                                {s}
                            </button>
                        ))}
                    </div>

                    {/* Typography */}
                    {activeSection === "typography" && (
                        <Card className="border-muted-foreground/10 shadow-none bg-background/30">
                            <CardHeader className="pb-4"><CardTitle className="text-sm font-bold">Typography</CardTitle></CardHeader>
                            <CardContent className="space-y-4">
                                <div className="space-y-1.5">
                                    <Label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground ml-1">Font Family</Label>
                                    <select value={template.fontName} onChange={(e) => set("fontName", e.target.value)}
                                        className="w-full h-10 rounded-xl border border-muted-foreground/10 bg-background/50 px-3 text-sm focus:ring-2 focus:ring-primary/20 transition-all outline-none">
                                        {FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
                                    </select>
                                </div>
                                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                                    <Toggle label="Bold" checked={template.bold} onChange={(v) => set("bold", v)} />
                                    <Toggle label="Italic" checked={template.italic} onChange={(v) => set("italic", v)} />
                                    <Toggle label="Underline" checked={template.underline} onChange={(v) => set("underline", v)} />
                                    <Toggle label="Uppercase" checked={template.uppercase} onChange={(v) => set("uppercase", v)} />
                                </div>
                                <div className="grid grid-cols-3 gap-3 pt-2">
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
                        <Card className="border-muted-foreground/10 shadow-none bg-background/30">
                            <CardHeader className="pb-4"><CardTitle className="text-sm font-bold">Colors & Outline</CardTitle></CardHeader>
                            <CardContent className="space-y-4">
                                <div className="grid grid-cols-2 gap-4">
                                    <ColorInput label="Text Color" value={template.fontColor} onChange={(v) => set("fontColor", v)} />
                                    <ColorInput label="Outline Color" value={template.outlineColor} onChange={(v) => set("outlineColor", v)} />
                                </div>
                                <div className="space-y-2">
                                    <Label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground ml-1">Border Style</Label>
                                    <div className="flex gap-2 p-1 bg-muted/30 rounded-xl border border-muted-foreground/10">
                                        {[{ v: 1, label: "Outline" }, { v: 3, label: "Opaque Box" }].map(({ v, label }) => (
                                            <button key={v} onClick={() => {
                                                set("borderStyle", v);
                                                if (v === 3 && !template.backColor) set("backColor", "#000000");
                                            }}
                                                className={`flex-1 py-1.5 text-xs font-bold rounded-lg transition-all duration-200 ${template.borderStyle === v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
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
                                <div className="space-y-3 pt-2">
                                    <Toggle label="Shadow Effect" checked={template.shadow} onChange={(v) => set("shadow", v)} />
                                    {template.shadow && (
                                        <div className="pl-6 border-l-2 border-primary/20 ml-2 animate-in slide-in-from-left-2">
                                            <NumberInput label="Shadow Depth" value={template.shadowDepth} onChange={(v) => set("shadowDepth", v)} min={0} max={5} step={0.5} />
                                        </div>
                                    )}
                                </div>
                            </CardContent>
                        </Card>
                    )}

                    {/* Position */}
                    {activeSection === "position" && (
                        <Card className="border-muted-foreground/10 shadow-none bg-background/30">
                            <CardHeader className="pb-4"><CardTitle className="text-sm font-bold">Alignment</CardTitle></CardHeader>
                            <CardContent>
                                <div className="space-y-3">
                                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                                        Choose where the captions appear on screen. This follows a standard numpad layout.
                                    </p>
                                    <div className="grid grid-cols-3 gap-2 max-w-[240px] mx-auto lg:mx-0 bg-muted/20 p-2 rounded-2xl border border-muted-foreground/5">
                                        {ALIGNMENTS.map(({ value, label }) => (
                                            <button key={value} onClick={() => set("alignment", value)}
                                                className={`aspect-square flex items-center justify-center text-xs font-black rounded-xl border transition-all duration-200 ${template.alignment === value ? "bg-primary text-primary-foreground border-primary shadow-md shadow-primary/20" : "bg-card/50 border-muted-foreground/10 hover:border-primary/30"}`}>
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
                        <Card className="border-muted-foreground/10 shadow-none bg-background/30">
                            <CardHeader className="pb-4"><CardTitle className="text-sm font-bold">Per-Aspect Layouts</CardTitle></CardHeader>
                            <CardContent className="space-y-4">
                                <div className="flex gap-1 p-1 bg-muted/30 rounded-xl border border-muted-foreground/10">
                                    {(["portrait", "square", "landscape"] as const).map((a) => (
                                        <button key={a} onClick={() => setActiveLayout(a)}
                                            className={`flex-1 px-3 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all duration-200 ${activeLayout === a ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
                                            {a === "portrait" ? "9:16" : a === "square" ? "1:1" : "16:9"}
                                        </button>
                                    ))}
                                </div>
                                {(["portrait", "square", "landscape"] as const).map((a) =>
                                    activeLayout === a ? (
                                        <div key={a} className="space-y-4 animate-in fade-in zoom-in-95 duration-200">
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
                    <Card className="sticky top-6 border-muted-foreground/10 shadow-xl shadow-black/5 overflow-hidden">
                        <CardHeader className="bg-muted/30 border-b pb-3">
                            <CardTitle className="text-xs font-black uppercase tracking-widest text-muted-foreground">Preview</CardTitle>
                        </CardHeader>
                        <CardContent className="p-4 space-y-4">
                            <div className="flex gap-1 p-1 bg-muted/50 rounded-lg border border-muted-foreground/5">
                                {ASPECT_OPTIONS.map((opt) => (
                                    <button key={opt.id} onClick={() => setPreviewAspect(opt.id)}
                                        className={`flex-1 flex items-center justify-center gap-1 py-1.5 text-[10px] font-bold rounded-md transition-all duration-200 ${previewAspect === opt.id ? "bg-card text-foreground shadow-sm border border-muted-foreground/10" : "text-muted-foreground hover:text-foreground"}`}>
                                        {opt.icon} {opt.label}
                                    </button>
                                ))}
                            </div>

                            <div className="flex justify-center py-2">
                                <CaptionTemplatePreview
                                    template={template}
                                    aspect={previewAspect}
                                    text={previewText || "HELLO WORLD"}
                                    className="rounded-2xl shadow-2xl flex-shrink-0"
                                    style={aspectStyle}
                                />
                            </div>

                            <div className="space-y-2 pt-2">
                                <div className="flex items-center justify-between">
                                    <Label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Background</Label>
                                    <div className="flex items-center gap-2">
                                        <input type="color" value={previewBgColor}
                                            onChange={(e) => setPreviewBgColor(e.target.value)}
                                            className="h-6 w-6 rounded-full border-none cursor-pointer p-0 overflow-hidden" />
                                        <span className="text-[10px] font-mono text-muted-foreground uppercase">{previewBgColor}</span>
                                    </div>
                                </div>
                                <div className="space-y-1.5 pt-2">
                                    <Label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Sample Text</Label>
                                    <Input value={previewText} onChange={(e) => setPreviewText(e.target.value)}
                                        placeholder="HELLO WORLD…" className="h-9 text-xs bg-muted/30 border-none" />
                                </div>
                            </div>

                            <Button variant="outline" className="w-full text-[10px] font-bold h-9 uppercase tracking-wider" onClick={renderPreview}
                                disabled={renderingPreview}>
                                {renderingPreview
                                    ? <><Loader2 className="h-3 w-3 mr-2 animate-spin" />Rendering…</>
                                    : <><Play className="h-3 w-3 mr-2" />Render with FFmpeg</>}
                            </Button>

                            {previewVideoUrl && (
                                <div className="animate-in fade-in zoom-in-95 duration-500 pt-2">
                                    <video ref={videoRef} src={previewVideoUrl} controls loop
                                        className="w-full rounded-xl border border-muted-foreground/10 shadow-lg" />
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </div>
            </div>

            <Dialog open={discardDialogOpen} onOpenChange={setDiscardDialogOpen}>
                <DialogContent className="rounded-3xl border-muted-foreground/10">
                    <DialogHeader>
                        <DialogTitle>Discard unsaved changes?</DialogTitle>
                        <DialogDescription>
                            You have unsaved changes to this caption template. If you leave now, those changes will be lost forever.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter className="gap-2 sm:gap-0">
                        <Button variant="ghost" onClick={() => setDiscardDialogOpen(false)} className="rounded-xl">
                            Keep Editing
                        </Button>
                        <Button variant="destructive" onClick={discardChangesAndNavigate} className="rounded-xl shadow-lg shadow-destructive/20">
                            Discard Changes
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete Template</AlertDialogTitle>
                        <AlertDialogDescription>
                            Are you sure you want to delete &quot;{template.name}&quot;? This action cannot be undone.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={async (e) => {
                                e.preventDefault();
                                setSaving(true);
                                try {
                                    await axios.delete(`${API_URL}/clips/caption-templates/${template.id}`);
                                    allowNavigationRef.current = true;
                                    router.push("/clips/settings/caption-templates");
                                } catch (e: unknown) {
                                    setError(getErrorMessage(e, "Failed to delete"));
                                    setConfirmDelete(false);
                                } finally {
                                    setSaving(false);
                                }
                            }}
                            className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
                            disabled={saving}
                        >
                            {saving ? "Deleting..." : "Delete Template"}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}

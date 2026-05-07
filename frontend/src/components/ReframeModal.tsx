'use client';

import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
const API_URL = process.env.NEXT_PUBLIC_API_URL;
import { 
  Smartphone, 
  Square, 
  Monitor, 
  Download, 
  Loader2, 
  Wand2, 
  Settings, 
  Eye,
  AlertCircle,
  CheckCircle,
  Type,
  Sparkles
} from 'lucide-react';
import SubjectDetection from './SubjectDetection';
import axios from 'axios';

// --- Interfaces (no changes) ---
interface Platform {
  id: string;
  name: string;
  aspectRatio: string;
  width: number;
  height: number;
  icon: React.ReactNode;
  description: string;
}
interface CropParameters { width: number; height: number; x: number; y: number; centerX: number; centerY: number; }
interface ClipHook { text: string; enabled: boolean; updatedAt?: string | null; }
interface ReframedVideo { filename: string; url: string; platform: string | null; platformName: string | null; aspectRatio: string | null; cropParameters?: CropParameters; hook?: { enabled: boolean; text?: string }; }
interface CaptionStyle {
  id: string;
  name: string;
  description: string;
  preview: {
    fontFamily: string;
    fontWeight: number;
    textColor: string;
    backgroundColor: string;
    borderColor: string;
    borderWidth: number;
    textShadow: string;
    portraitFontSize: number;
    squareFontSize: number;
    landscapeFontSize: number;
  };
}
interface ReframeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onGenerationComplete?: () => Promise<void> | void;
  transcriptId: string;
  videoUrl: string;
  originalFilename: string;
  videoDimensions?: { width: number; height: number };
  generatedClipUrl?: string;
  sourceVideoId?: string;
  clipIndex?: number;
  clipDefinition?: any;
  clipTimeline?: any[] | null;
  clipHook?: ClipHook;
  transcriptData?: any[]; // Pass transcript data for active speaker detection
}

// --- Constants & Helper Functions (with additions) ---
const PLATFORMS: Platform[] = [
  { id: 'tiktok', name: 'TikTok/Shorts', aspectRatio: '9:16', width: 9, height: 16, icon: <Smartphone className="w-5 h-5" />, description: 'Vertical format for TikTok, YouTube Shorts, Instagram Reels' },
  { id: 'instagram', name: 'Instagram Square', aspectRatio: '1:1', width: 1, height: 1, icon: <Square className="w-5 h-5" />, description: 'Square format for Instagram feed posts' },
  { id: 'youtube', name: 'YouTube Landscape', aspectRatio: '16:9', width: 16, height: 9, icon: <Monitor className="w-5 h-5" />, description: 'Widescreen format for YouTube, Facebook, LinkedIn' },
];

// NEW: Helper to generate CSS for caption style previews
const getCaptionStyleCSS = (style: CaptionStyle, platformId: string): React.CSSProperties => {
    const layout = platformId === 'youtube' ? 'landscape' : platformId === 'instagram' ? 'square' : 'portrait';
    const fontSize = layout === 'portrait'
        ? style.preview.portraitFontSize
        : layout === 'landscape'
            ? style.preview.landscapeFontSize
            : style.preview.squareFontSize;
    const baseStyle: React.CSSProperties = {
        position: 'absolute', bottom: '15%', left: '50%', transform: 'translateX(-50%)',
        textAlign: 'center', fontSize: `${fontSize}px`, fontWeight: style.preview.fontWeight, padding: '0.2em 0.5em',
        borderRadius: '8px', width: layout === 'portrait' ? '68%' : '80%', lineHeight: '1.2',
        fontFamily: style.preview.fontFamily,
        color: style.preview.textColor,
        backgroundColor: style.preview.backgroundColor,
        textShadow: style.preview.textShadow,
        border: style.preview.borderWidth > 0 ? `${style.preview.borderWidth}px solid ${style.preview.borderColor}` : 'none'
    };
    return baseStyle;
};

const getHookStyleCSS = (style: CaptionStyle, platformId: string): React.CSSProperties => ({
    ...getCaptionStyleCSS(style, platformId),
    top: '12%',
    bottom: 'auto',
    width: platformId === 'youtube' ? '76%' : '72%'
});

const ReframeModal: React.FC<ReframeModalProps> = ({
  isOpen, onClose, onGenerationComplete, transcriptId, videoUrl, originalFilename, generatedClipUrl, sourceVideoId, clipIndex, clipDefinition, clipTimeline, clipHook
}) => {
  // --- State Management (no major changes, `currentTab` removed) ---
  const [selectedPlatform, setSelectedPlatform] = useState<string>('tiktok');
  const [detections, setDetections] = useState<any[]>([]);
  const [cropParameters, setCropParameters] = useState<CropParameters | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState(0);
  const [reframedVideo, setReframedVideo] = useState<ReframedVideo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outputName, setOutputName] = useState<string>('');
  const [captionStyles, setCaptionStyles] = useState<CaptionStyle[]>([]);
  const [selectedCaptionStyle, setSelectedCaptionStyle] = useState<string>('');
  const [addCaptions, setAddCaptions] = useState<boolean>(false);
  const [addTopHook, setAddTopHook] = useState<boolean>(false);
  const [topHookText, setTopHookText] = useState<string>('');
  const [keepOriginalFrame, setKeepOriginalFrame] = useState<boolean>(false);
  const [startTime, setStartTime] = useState<number>(0);
  const [endTime, setEndTime] = useState<number>(0);
  const [activeSpeakerFace, setActiveSpeakerFace] = useState<any | null>(null);
  const [analysisMode, setAnalysisMode] = useState<'center' | 'detection' | null>(null);
  // NEW: State to manage the visibility of advanced settings
  const [isAdvancedSettingsOpen, setIsAdvancedSettingsOpen] = useState(false);
  const assetKey = generatedClipUrl || videoUrl;

  // --- Hooks and Handlers (no major changes to logic) ---
  useEffect(() => {
    if (isOpen && originalFilename) {
      const platform = PLATFORMS.find(p => p.id === selectedPlatform);
      const baseName = originalFilename.replace(/\.[^.]+$/, '');
      setOutputName(keepOriginalFrame ? `${baseName}_overlay.mp4` : `${baseName}_${platform?.id}_reframed.mp4`);
      setStartTime(0);
      setEndTime(0);
    }
  }, [isOpen, originalFilename, selectedPlatform, keepOriginalFrame]);

  useEffect(() => {
    if (!isOpen) return;
    const text = clipHook?.text || '';
    setTopHookText(text);
    setAddTopHook(Boolean(clipHook?.enabled && text.trim()));
  }, [isOpen, clipHook?.enabled, clipHook?.text]);

  useEffect(() => {
    if (isOpen) fetchCaptionStyles();
  }, [isOpen]);

  const fetchCaptionStyles = async () => {
    try {
      const response = await axios.get(`${API_URL}/clips/captions/styles`);
      setCaptionStyles(response.data.styles);
      if (response.data.styles.length > 0) {
        setSelectedCaptionStyle(response.data.styles[0].id);
      }
    } catch (error) { console.error('Failed to fetch caption styles:', error); }
  };

  const analyzeVideo = async (detectionResults: any[]) => {
    try {
      setIsAnalyzing(true);
      setError(null);
      const speakerFace = detectionResults.length > 0 ? detectionResults[0].boundingBox : null;
      setActiveSpeakerFace(speakerFace);
      const response = await axios.post(`${API_URL}/clips/reframe/analyze`, {
        transcriptId,
        targetPlatform: selectedPlatform,
        detections: detectionResults,
        generatedClipUrl,
        activeSpeakerFace: speakerFace
      });
      if (response.data.success) {
        setDetections(detectionResults);
        setCropParameters(response.data.analysis.cropParameters);
        setPreviewUrl(response.data.analysis.previewUrl);
        setAnalysisMode(response.data.analysis.mode || null);
      } else {
        setError('Failed to analyze video for reframing');
      }
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to analyze video');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleDetectionComplete = async (detectionResults: any[]) => {
    await analyzeVideo(detectionResults);
  };

  useEffect(() => {
    if (!isOpen) return;
    if (keepOriginalFrame) {
      setIsAnalyzing(false);
      setCropParameters(null);
      setPreviewUrl(null);
      setAnalysisMode(null);
      return;
    }

    let cancelled = false;

    const loadSavedState = async () => {
      try {
        setIsAnalyzing(true);
        const response = await axios.get(`${API_URL}/clips/transcripts/${transcriptId}`);
        if (cancelled) return;

        const assetState = response.data.reframeAssets?.[assetKey];
        const savedAnalysis = assetState?.analyses?.[selectedPlatform];
        const savedDetections = assetState?.detections || [];

        if (savedAnalysis?.cropParameters && savedAnalysis?.previewUrl) {
          setDetections(savedDetections);
          setActiveSpeakerFace(savedDetections[0]?.boundingBox || null);
          setCropParameters(savedAnalysis.cropParameters);
          setPreviewUrl(savedAnalysis.previewUrl);
          setAnalysisMode(savedAnalysis.mode || null);
          setError(null);
          setIsAnalyzing(false);
          return;
        }

        setIsAnalyzing(false);
        await analyzeVideo(savedDetections);
      } catch (error: any) {
        if (cancelled) return;
        setIsAnalyzing(false);
        setError(error.response?.data?.error || 'Failed to load saved reframe data');
      }
    };

    loadSavedState();

    return () => {
      cancelled = true;
    };
  }, [isOpen, selectedPlatform, transcriptId, assetKey, keepOriginalFrame]);

  const handleKeepOriginalFrameChange = (enabled: boolean) => {
    setKeepOriginalFrame(enabled);
    setError(null);
    if (enabled) {
      setDetections([]);
      setCropParameters(null);
      setPreviewUrl(null);
      setAnalysisMode(null);
      setIsAnalyzing(false);
    }
  };

  const handleGenerate = async () => {
    if (!keepOriginalFrame && !cropParameters) { setError('No crop parameters. Please analyze first.'); return; }
    const normalizedHookText = topHookText.trim();
    const hookEnabled = Boolean(addTopHook && normalizedHookText);
    if (keepOriginalFrame && !addCaptions && !hookEnabled) { setError('Enable captions or a top hook to keep the original frame.'); return; }
    try {
      setIsGenerating(true); setGenerationProgress(0); setError(null);
      const progressInterval = setInterval(() => setGenerationProgress(prev => Math.min(prev + Math.random() * 10, 90)), 500);
      const response = await axios.post(`${API_URL}/clips/reframe/generate`, {
        transcriptId, 
        targetPlatform: selectedPlatform, 
        cropParameters: keepOriginalFrame ? null : cropParameters,
        detections: keepOriginalFrame ? [] : detections,
        outputName, 
        generatedClipUrl,
        captions: addCaptions ? { enabled: true, style: selectedCaptionStyle } : { enabled: false },
        hook: hookEnabled ? { enabled: true, text: normalizedHookText } : { enabled: false },
        activeSpeakerFace,
        clipDefinition,
        clipTimeline,
        clipIndex,
        sourceVideoId,
        processingMode: keepOriginalFrame ? 'captions-only' : 'reframe'
      });
      clearInterval(progressInterval); setGenerationProgress(100);
      if (response.data.success) { setReframedVideo(response.data.reframedVideo); await onGenerationComplete?.();
      } else { setError('Failed to generate reframed video'); }
    } catch (err: any) { setError(err.response?.data?.error || 'Failed to generate reframed video');
    } finally { setIsGenerating(false); }
  };

  const resetModal = () => {
    setDetections([]); setCropParameters(null); setPreviewUrl(null); setReframedVideo(null);
    setError(null); setIsAnalyzing(false); setIsGenerating(false); setGenerationProgress(0); setAnalysisMode(null);
    setKeepOriginalFrame(false);
    setAddCaptions(false);
  };

  const handleClose = () => { resetModal(); onClose(); };

  // --- NEW: Redesigned JSX Structure ---
  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto p-0">
        <DialogHeader className="p-6 pb-4">
          <DialogTitle className="flex items-center gap-2 text-xl">
            <Sparkles className="w-6 h-6 text-blue-500" />
            AI Clip Generator
          </DialogTitle>
        </DialogHeader>

        <div className="p-6 space-y-8">
          {reframedVideo ? (
            // --- RESULT VIEW ---
            <div className="space-y-4 text-center">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center justify-center gap-2">
                    <CheckCircle className="w-6 h-6 text-green-500" />
                    Clip Generated Successfully!
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <video src={`${API_URL}${reframedVideo.url}`} controls className="w-full rounded-lg mx-auto max-w-sm" />
                  <Button asChild size="lg" className="w-full max-w-sm">
                    <a href={`${API_URL}${reframedVideo.url}`} download={reframedVideo.filename}>
                      <Download className="w-4 h-4 mr-2" />
                      Download Video
                    </a>
                  </Button>
                </CardContent>
              </Card>
              <Button variant="outline" onClick={handleClose}>Close</Button>
            </div>
          ) : (
            // --- SETTINGS VIEW ---
            <>
              <div className="space-y-3">
                <Label className="text-base font-medium">Mode</Label>
                <div className="grid grid-cols-2 gap-3">
                  <Card onClick={() => handleKeepOriginalFrameChange(false)}
                    className={`cursor-pointer transition-all p-4 ${!keepOriginalFrame ? 'ring-2 ring-blue-500 bg-blue-50' : 'hover:bg-gray-50'}`}>
                    <div className="flex items-center gap-3">
                      <Wand2 className="w-5 h-5" />
                      <div className="font-medium text-sm">Smart crop</div>
                    </div>
                  </Card>
                  <Card onClick={() => handleKeepOriginalFrameChange(true)}
                    className={`cursor-pointer transition-all p-4 ${keepOriginalFrame ? 'ring-2 ring-blue-500 bg-blue-50' : 'hover:bg-gray-50'}`}>
                    <div className="flex items-center gap-3">
                      <Type className="w-5 h-5" />
                      <div className="font-medium text-sm">Keep original frame</div>
                    </div>
                  </Card>
                </div>
              </div>

              {/* Aspect Ratio Selection */}
              {!keepOriginalFrame && <div className="space-y-3">
                <Label className="text-base font-medium">1. Aspect Ratio</Label>
                <div className="grid grid-cols-3 gap-3">
                  {PLATFORMS.map((platform) => (
                    <Card key={platform.id} onClick={() => setSelectedPlatform(platform.id)}
                      className={`cursor-pointer transition-all text-center p-4 ${selectedPlatform === platform.id ? 'ring-2 ring-blue-500 bg-blue-50' : 'hover:bg-gray-50'}`}>
                      <div className="flex flex-col items-center gap-2">
                        {platform.icon}
                        <div className="font-medium text-sm">{platform.name}</div>
                      </div>
                    </Card>
                  ))}
                </div>
              </div>}

              {/* AI Subject Detection & Preview */}
              {!keepOriginalFrame && <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><Eye className="w-5 h-5" />2. AI Smart Frame</CardTitle>
                  <CardDescription>Our AI finds the best shot. Click the video to start.</CardDescription>
                </CardHeader>
                <CardContent>
                  {previewUrl && cropParameters ? (
                    <div className="grid md:grid-cols-2 gap-6 items-center">
                      <img src={`${API_URL}${previewUrl}`} alt="Reframed preview" className="w-full rounded-lg border" />
                      <div className="space-y-4">
                        <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
                          <h4 className="font-semibold text-green-800">Analysis Complete</h4>
                          <p className="text-sm text-green-700 mt-1">
                            {analysisMode === 'center'
                              ? `Using center crop for ${PLATFORMS.find(p=>p.id===selectedPlatform)?.name}.`
                              : `Optimal crop found for ${PLATFORMS.find(p=>p.id===selectedPlatform)?.name}.`}
                          </p>
                        </div>
                        <Button variant="outline" onClick={() => setPreviewUrl(null)}>Re-analyze</Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <SubjectDetection videoUrl={`${API_URL}${videoUrl}`} onDetectionComplete={handleDetectionComplete} onError={setError} />
                      {isAnalyzing && <div className="mt-4 flex items-center gap-2 text-blue-600"><Loader2 className="w-4 h-4 animate-spin" /><span>Calculating optimal crop...</span></div>}
                    </>
                  )}
                </CardContent>
              </Card>}

              {/* Captions */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><Type className="w-5 h-5" />{keepOriginalFrame ? '1' : '3'}. Captions</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* REPLACED: Switch with a styled checkbox */}
                  <div className="flex items-center space-x-3">
                    <input
                      type="checkbox"
                      id="addCaptions"
                      checked={addCaptions}
                      onChange={(e) => setAddCaptions(e.target.checked)}
                      className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <Label htmlFor="addCaptions" className="text-base cursor-pointer">Add Animated Captions</Label>
                  </div>
                  {addCaptions && (
                    <div className="space-y-4">
                      <p className="text-sm text-gray-600">Select a style for your burned-in captions.</p>
                      <div className="flex gap-3 overflow-x-auto pb-3">
                        {captionStyles.map(style => (
                          <div key={style.id} onClick={() => setSelectedCaptionStyle(style.id)}
                            className={`relative flex-shrink-0 w-32 h-48 bg-gray-800 rounded-lg cursor-pointer transition-all overflow-hidden ${selectedCaptionStyle === style.id ? 'ring-2 ring-blue-500' : ''}`}>
                            <div style={getCaptionStyleCSS(style, selectedPlatform)}>Sample Text</div>
                            <div className="absolute bottom-0 w-full p-2 bg-black/50">
                              <p className="text-white text-xs font-medium truncate">{style.name}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Top Hook */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><Sparkles className="w-5 h-5" />{keepOriginalFrame ? '2' : '4'}. Top Hook</CardTitle>
                  <CardDescription>Optional top overlay shown for the full clip.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center space-x-3">
                    <input
                      type="checkbox"
                      id="addTopHook"
                      checked={addTopHook}
                      onChange={(e) => setAddTopHook(e.target.checked)}
                      className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <Label htmlFor="addTopHook" className="text-base cursor-pointer">Burn in Top Hook</Label>
                  </div>
                  <textarea
                    value={topHookText}
                    onChange={(e) => setTopHookText(e.target.value)}
                    rows={2}
                    maxLength={120}
                    placeholder="Add a short hook for the top of the clip"
                    className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                  />
                  {addTopHook && !topHookText.trim() && (
                    <p className="text-xs text-amber-700">Hook burn-in will be skipped until text is added.</p>
                  )}
                  {addTopHook && captionStyles.length > 0 && selectedCaptionStyle && (
                    <div className="relative h-32 overflow-hidden rounded-lg bg-gray-800">
                      <div style={getHookStyleCSS(captionStyles.find(style => style.id === selectedCaptionStyle) || captionStyles[0], selectedPlatform)}>
                        {topHookText.trim() || 'Hook preview'}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* REPLACED: Accordion with a Button toggle */}
              <div className="space-y-4">
                <Button variant="outline" onClick={() => setIsAdvancedSettingsOpen(!isAdvancedSettingsOpen)} className="w-full justify-start">
                  <Settings className="w-4 h-4 mr-2" />
                  Advanced Settings
                </Button>
                {isAdvancedSettingsOpen && (
                  <div className="p-4 border rounded-lg space-y-4">
                    <div>
                      <Label htmlFor="outputName">Output Filename</Label>
                      <Input id="outputName" value={outputName} onChange={(e) => setOutputName(e.target.value)} className="mt-1" />
                    </div>
                    <div className="grid md:grid-cols-2 gap-4">
                      <div><Label htmlFor="startTime">Start Time (sec)</Label><Input id="startTime" type="number" min="0" value={startTime} onChange={(e) => setStartTime(Number(e.target.value))} className="mt-1" /></div>
                      <div><Label htmlFor="endTime">End Time (sec)</Label><Input id="endTime" type="number" min={startTime} value={endTime} onChange={(e) => setEndTime(Number(e.target.value))} className="mt-1" /></div>
                    </div>
                  </div>
                )}
              </div>

              {/* Error Display */}
              {error && <div className="flex items-center gap-2 p-3 bg-red-50 text-red-700 rounded-lg"><AlertCircle className="w-5 h-5" /><span>{error}</span></div>}

              {/* Action Buttons */}
              <div className="pt-6 border-t flex justify-between items-center">
                <Button variant="ghost" onClick={handleClose}>Cancel</Button>
                <Button size="lg" onClick={handleGenerate} disabled={isGenerating || (!keepOriginalFrame && !cropParameters) || (keepOriginalFrame && !addCaptions && !Boolean(addTopHook && topHookText.trim()))}>
                  {isGenerating ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Generating... {Math.round(generationProgress)}%</> : 'Generate Clip'}
                </Button>
              </div>
              {isGenerating && <Progress value={generationProgress} className="w-full" />}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default ReframeModal;

'use client';

import { useCallback, useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  AlertCircle,
  CheckCircle,
  Download,
  Eye,
  Loader2,
  Monitor,
  Smartphone,
  Sparkles,
  Square,
} from 'lucide-react';
import SubjectDetection from './SubjectDetection';
import axios from 'axios';

const API_URL = process.env.NEXT_PUBLIC_API_URL;

interface Platform {
  id: string;
  name: string;
  aspectRatio: string;
  width: number;
  height: number;
  icon: React.ReactNode;
  description: string;
}

interface CropParameters {
  width: number;
  height: number;
  x: number;
  y: number;
  centerX: number;
  centerY: number;
}

interface Detection {
  boundingBox: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  confidence: number;
  type: 'face';
  id?: number;
  time?: number;
}

interface SmartCroppedVideo {
  filename: string;
  url: string;
  platform: string | null;
  platformName: string | null;
  aspectRatio: string | null;
  cropParameters?: CropParameters;
}

interface SmartCropModalProps {
  isOpen: boolean;
  onClose: () => void;
  onGenerationComplete?: () => Promise<void> | void;
  transcriptId: string;
  videoUrl: string;
  generatedClipUrl?: string;
  sourceVideoId?: string;
  clipIndex?: number;
  clipDefinition?: unknown;
  clipTimeline?: unknown[] | null;
}

const getErrorMessage = (error: unknown, fallback: string) => {
  if (axios.isAxiosError<{ error?: string }>(error)) {
    return error.response?.data?.error || fallback;
  }
  return fallback;
};

const PLATFORMS: Platform[] = [
  {
    id: 'tiktok',
    name: 'TikTok/Shorts',
    aspectRatio: '9:16',
    width: 9,
    height: 16,
    icon: <Smartphone className="h-5 w-5" />,
    description: 'Vertical format for TikTok, YouTube Shorts, Instagram Reels',
  },
  {
    id: 'instagram',
    name: 'Instagram Square',
    aspectRatio: '1:1',
    width: 1,
    height: 1,
    icon: <Square className="h-5 w-5" />,
    description: 'Square format for Instagram feed posts',
  },
  {
    id: 'youtube',
    name: 'YouTube Landscape',
    aspectRatio: '16:9',
    width: 16,
    height: 9,
    icon: <Monitor className="h-5 w-5" />,
    description: 'Widescreen format for YouTube, Facebook, LinkedIn',
  },
];

const SmartCropModal: React.FC<SmartCropModalProps> = ({
  isOpen,
  onClose,
  onGenerationComplete,
  transcriptId,
  videoUrl,
  generatedClipUrl,
  sourceVideoId,
  clipIndex,
  clipDefinition,
  clipTimeline,
}) => {
  const [selectedPlatform, setSelectedPlatform] = useState('tiktok');
  const [detections, setDetections] = useState<Detection[]>([]);
  const [cropParameters, setCropParameters] = useState<CropParameters | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState(0);
  const [croppedVideo, setCroppedVideo] = useState<SmartCroppedVideo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeSpeakerFace, setActiveSpeakerFace] = useState<Detection['boundingBox'] | null>(null);
  const [analysisMode, setAnalysisMode] = useState<'center' | 'detection' | null>(null);
  const assetKey = generatedClipUrl || videoUrl;

  const analyzeVideo = useCallback(async (detectionResults: Detection[]) => {
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
        activeSpeakerFace: speakerFace,
      });

      if (response.data.success) {
        setDetections(detectionResults);
        setCropParameters(response.data.analysis.cropParameters);
        setPreviewUrl(response.data.analysis.previewUrl);
        setAnalysisMode(response.data.analysis.mode || null);
      } else {
        setError('Failed to analyze video for smart crop');
      }
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Failed to analyze video'));
    } finally {
      setIsAnalyzing(false);
    }
  }, [generatedClipUrl, selectedPlatform, transcriptId]);

  useEffect(() => {
    if (!isOpen) return;

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
      } catch (err: unknown) {
        if (cancelled) return;
        setIsAnalyzing(false);
        setError(getErrorMessage(err, 'Failed to load saved smart crop data'));
      }
    };

    loadSavedState();

    return () => {
      cancelled = true;
    };
  }, [analyzeVideo, isOpen, selectedPlatform, transcriptId, assetKey]);

  const handleDetectionComplete = async (detectionResults: Detection[]) => {
    await analyzeVideo(detectionResults);
  };

  const handleGenerate = async () => {
    if (!cropParameters) {
      setError('No crop parameters. Please analyze first.');
      return;
    }

    let progressInterval: ReturnType<typeof setInterval> | null = null;

    try {
      setIsGenerating(true);
      setGenerationProgress(0);
      setError(null);

      progressInterval = setInterval(
        () => setGenerationProgress(prev => Math.min(prev + Math.random() * 10, 90)),
        500
      );

      const response = await axios.post(`${API_URL}/clips/reframe/generate`, {
        transcriptId,
        targetPlatform: selectedPlatform,
        cropParameters,
        detections,
        generatedClipUrl,
        captions: { enabled: false },
        hook: { enabled: false },
        activeSpeakerFace,
        clipDefinition,
        clipTimeline,
        clipIndex,
        sourceVideoId,
        processingMode: 'reframe',
      });

      clearInterval(progressInterval);
      progressInterval = null;
      setGenerationProgress(100);

      if (response.data.success) {
        setCroppedVideo(response.data.reframedVideo);
        await onGenerationComplete?.();
      } else {
        setError('Failed to generate smart crop');
      }
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Failed to generate smart crop'));
    } finally {
      if (progressInterval) clearInterval(progressInterval);
      setIsGenerating(false);
    }
  };

  const resetModal = () => {
    setDetections([]);
    setCropParameters(null);
    setPreviewUrl(null);
    setCroppedVideo(null);
    setError(null);
    setIsAnalyzing(false);
    setIsGenerating(false);
    setGenerationProgress(0);
    setActiveSpeakerFace(null);
    setAnalysisMode(null);
  };

  const handleClose = () => {
    resetModal();
    onClose();
  };

  const selectedPlatformLabel = PLATFORMS.find(platform => platform.id === selectedPlatform)?.name;

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto p-0">
        <DialogHeader className="p-6 pb-4">
          <DialogTitle className="flex items-center gap-2 text-xl">
            <Sparkles className="h-6 w-6 text-blue-500" />
            Smart Crop
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-8 p-6">
          {croppedVideo ? (
            <div className="space-y-4 text-center">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center justify-center gap-2">
                    <CheckCircle className="h-6 w-6 text-green-500" />
                    Smart Crop Generated
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <video src={`${API_URL}${croppedVideo.url}`} controls className="mx-auto w-full max-w-sm rounded-lg" />
                  <Button asChild size="lg" className="w-full max-w-sm">
                    <a href={`${API_URL}${croppedVideo.url}`} download={croppedVideo.filename}>
                      <Download className="mr-2 h-4 w-4" />
                      Download Video
                    </a>
                  </Button>
                </CardContent>
              </Card>
              <Button variant="outline" onClick={handleClose}>Close</Button>
            </div>
          ) : (
            <>
              <div className="space-y-3">
                <Label className="text-base font-medium">1. Target Format</Label>
                <div className="grid gap-3 sm:grid-cols-3">
                  {PLATFORMS.map(platform => (
                    <Card
                      key={platform.id}
                      onClick={() => setSelectedPlatform(platform.id)}
                      className={`cursor-pointer p-4 text-center transition-all ${
                        selectedPlatform === platform.id ? 'bg-blue-50 ring-2 ring-blue-500' : 'hover:bg-gray-50'
                      }`}
                    >
                      <div className="flex flex-col items-center gap-2">
                        {platform.icon}
                        <div className="text-sm font-medium">{platform.name}</div>
                        <div className="text-xs text-muted-foreground">{platform.aspectRatio}</div>
                      </div>
                    </Card>
                  ))}
                </div>
              </div>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Eye className="h-5 w-5" />
                    2. Detect Subject and Preview Crop
                  </CardTitle>
                  <CardDescription>Detect the subject or object, then preview the crop before generating.</CardDescription>
                </CardHeader>
                <CardContent>
                  {previewUrl && cropParameters ? (
                    <div className="grid items-center gap-6 md:grid-cols-2">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={`${API_URL}${previewUrl}`} alt="Smart crop preview" className="w-full rounded-lg border" />
                      <div className="space-y-4">
                        <div className="rounded-lg border border-green-200 bg-green-50 p-3">
                          <h4 className="font-semibold text-green-800">Preview Ready</h4>
                          <p className="mt-1 text-sm text-green-700">
                            {analysisMode === 'center'
                              ? `Using center crop for ${selectedPlatformLabel}.`
                              : `Subject-aware crop found for ${selectedPlatformLabel}.`}
                          </p>
                        </div>
                        <Button variant="outline" onClick={() => setPreviewUrl(null)}>Re-analyze</Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <SubjectDetection
                        videoUrl={`${API_URL}${videoUrl}`}
                        onDetectionComplete={handleDetectionComplete}
                        onError={setError}
                      />
                      {isAnalyzing && (
                        <div className="mt-4 flex items-center gap-2 text-blue-600">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          <span>Calculating crop...</span>
                        </div>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>

              {error && (
                <div className="flex items-center gap-2 rounded-lg bg-red-50 p-3 text-red-700">
                  <AlertCircle className="h-5 w-5" />
                  <span>{error}</span>
                </div>
              )}

              <div className="flex items-center justify-between border-t pt-6">
                <Button variant="ghost" onClick={handleClose}>Cancel</Button>
                <Button size="lg" onClick={handleGenerate} disabled={isGenerating || !cropParameters}>
                  {isGenerating ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Generating... {Math.round(generationProgress)}%
                    </>
                  ) : (
                    'Generate Smart Crop'
                  )}
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

export default SmartCropModal;

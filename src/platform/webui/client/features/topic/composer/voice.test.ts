// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { OverlayManager } from '../../../services/overlays.js';
import { createVoiceController, formatMicElapsed, selectRecordType, voiceExt } from './voice.js';

describe('composer/voice', () => {
  it('maps audio MIME types to file extensions and formats elapsed recording time', () => {
    expect(voiceExt('audio/mp4')).toBe('m4a');
    expect(voiceExt('audio/ogg')).toBe('ogg');
    expect(voiceExt('audio/webm')).toBe('webm');
    expect(formatMicElapsed(1000, 1000)).toBe('0:00');
    expect(formatMicElapsed(1000, 66000)).toBe('1:05');
  });

  it('picks the first supported recording MIME in priority order', () => {
    expect(selectRecordType((m) => m === 'audio/webm;codecs=opus')).toBe('audio/webm;codecs=opus');
    expect(selectRecordType(() => false)).toBe('');
  });

  it('guards Escape while recording, transcribes on stop, and falls back to audio upload on 404', async () => {
    const micBtn = document.createElement('button');
    const note = document.createElement('div');
    document.body.append(micBtn, note);

    const stopTrack = vi.fn();
    const mockStream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
    let startedCount = 0;

    class FakeMediaRecorder {
      static isTypeSupported = (m: string) => m === 'audio/webm;codecs=opus';
      mimeType = 'audio/webm;codecs=opus';
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start(): void {
        startedCount += 1;
      }
      stop(): void {
        this.ondataavailable?.({ data: new Blob(['audio-bytes'], { type: 'audio/webm' }) });
        this.onstop?.();
      }
    }

    Object.defineProperty(window, 'MediaRecorder', { value: FakeMediaRecorder, configurable: true });
    Object.defineProperty(globalThis, 'MediaRecorder', { value: FakeMediaRecorder, configurable: true });
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn().mockResolvedValue(mockStream) },
      configurable: true,
    });

    const overlays = new OverlayManager();
    const fallbackClose = vi.fn(() => true);
    overlays.registerFallback(fallbackClose);
    overlays.attach(document);

    const appendDictation = vi.fn();
    const dispatchAudio = vi.fn();
    const postFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, text: 'raw', cleaned: 'cleaned text', latencyMs: 500 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response('not found', { status: 404 }));

    const ctrl = createVoiceController({
      micBtn,
      note,
      overlays,
      doc: document,
      win: window,
      getTopic: () => 't1',
      getIcons: () => ({ mic: 'M', stop: 'S', copy: 'C', check: 'K', cross: 'X' }),
      appendDictation,
      dispatchAudio,
      postFn,
      now: () => 5000,
    });
    const sub = ctrl.attach();
    expect(micBtn.hidden).toBe(false);

    // Start recording, press Escape -> discards recording and blocks overlay fallback.
    micBtn.click();
    await vi.waitFor(() => expect(ctrl.isRecording()).toBe(true));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(ctrl.isRecording()).toBe(false);
    expect(fallbackClose).not.toHaveBeenCalled();
    expect(postFn).not.toHaveBeenCalled();
    expect(startedCount).toBe(1);

    // Record again and click micBtn to stop -> transcribes and appends dictation.
    micBtn.click();
    await vi.waitFor(() => expect(ctrl.isRecording()).toBe(true));
    micBtn.click();
    await vi.waitFor(() => expect(appendDictation).toHaveBeenCalledWith('t1', 'cleaned text'));

    // Record again -> 404 falls back to dispatchAudio.
    micBtn.click();
    await vi.waitFor(() => expect(ctrl.isRecording()).toBe(true));
    micBtn.click();
    await vi.waitFor(() => expect(dispatchAudio).toHaveBeenCalledTimes(1));
    expect(dispatchAudio.mock.calls[0]?.[0]?.[0]?.name).toBe('voice-1.webm');

    sub.dispose();
    ctrl.dispose();
    overlays.dispose();
  });
});

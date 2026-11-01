/** Piper release the bot installs. The tarball hash is pinned in `PIPER_BINARY`. */
export const PIPER_RELEASE = '2023.11.14-2';

/** DJ voice when `dj.piperVoice` is missing or not in the pin table. */
export const DEFAULT_PIPER_VOICE = 'en_US-ryan-high';

/** Station IDs and promos. British, so the break is not the same voice as the DJ. */
export const DEFAULT_PIPER_JINGLE_VOICE = 'en_GB-alan-medium';

/** One file the bot may download. Size and hash are checked before it is used. */
export interface PinnedFile {
  /** Shown in the download log. */
  name: string;
  url: string;
  bytes: number;
  sha256: string;
}

const HF = 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0';

function voice(
  id: string,
  path: string,
  modelBytes: number,
  modelSha: string,
  jsonBytes: number,
  jsonSha: string,
): { model: PinnedFile; config: PinnedFile } {
  const modelUrl = `${HF}/${path}`;
  return {
    model: { name: id, url: modelUrl, bytes: modelBytes, sha256: modelSha },
    config: {
      name: `${id}.onnx.json`,
      url: `${modelUrl}.json`,
      bytes: jsonBytes,
      sha256: jsonSha,
    },
  };
}

/** Linux x64 Piper 2023.11.14-2. Other platforms are not pinned. */
export const PIPER_BINARY: PinnedFile = {
  name: PIPER_RELEASE,
  url: 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz',
  bytes: 26_460_462,
  sha256: 'a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992',
};

/**
 * Voices the bot is allowed to speak with. A config name outside this table
 * falls back to the default. Hashes are of the files as published.
 */
export const PIPER_VOICES: Record<string, { model: PinnedFile; config: PinnedFile }> = {
  'en_US-ryan-high': voice(
    'en_US-ryan-high',
    'en/en_US/ryan/high/en_US-ryan-high.onnx',
    120_786_792,
    'b3990d7606e183ec8dbfba70a4607074f162de1a0c412e0180d1ff60bb154eca',
    4_166,
    'c6d3b98f08315cb4bebf0d49d50fc4ff491b503c64b940cd3d5ca28543b48011',
  ),
  'en_US-ryan-medium': voice(
    'en_US-ryan-medium',
    'en/en_US/ryan/medium/en_US-ryan-medium.onnx',
    63_201_294,
    'abf4c274862564ed647ba0d2c47f8ee7c9b717d27bdad9219100eb310db4047a',
    4_883,
    '44034c056cb15681b2ad494307c7f3f2e4499d1253c700c711fa0a4607ffe78d',
  ),
  'en_GB-alan-medium': voice(
    'en_GB-alan-medium',
    'en/en_GB/alan/medium/en_GB-alan-medium.onnx',
    63_201_294,
    '0a309668932205e762801f1efc2736cd4b0120329622adf62be09e56339d3330',
    4_888,
    'c0f0d124e5895c00e7c03b35dcc8287f319a6998a365b182deb5c8e752ee8c1e',
  ),
};

/** Names `dj.piperVoice` and `dj.piperJingleVoice` may use. */
export const PIPER_VOICE_IDS: ReadonlySet<string> = new Set(Object.keys(PIPER_VOICES));

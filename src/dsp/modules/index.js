import { Echoforge } from './echoforge.js';
import { TapePhantom } from './tape.js';
import { ChronoShredder } from './chrono.js';
import { PrismEngine } from './prism.js';
import { Overmind } from './overmind.js';
import { Subverter } from './subverter.js';
import { StaticBloom } from './bloom.js';
import { DustEngine } from './dust.js';
import { SpectralGhost } from './ghost.js';
import { GlitchOracle } from './glitch.js';
import { OrbitLFO } from './orbit.js';
import { ReactorFM } from './reactor.js';
import { DriftField } from './drift.js';
import { ProbabilityGate } from './pgate.js';
import { StereoSplitter, StereoMerger, Mixer } from './utility.js';
import { FeedbackTamer } from './tamer.js';

export const MODULE_CLASSES = {
  echoforge: Echoforge,
  tape: TapePhantom,
  chrono: ChronoShredder,
  prism: PrismEngine,
  overmind: Overmind,
  subverter: Subverter,
  bloom: StaticBloom,
  dust: DustEngine,
  ghost: SpectralGhost,
  glitch: GlitchOracle,
  orbit: OrbitLFO,
  reactor: ReactorFM,
  drift: DriftField,
  pgate: ProbabilityGate,
  splitter: StereoSplitter,
  merger: StereoMerger,
  mixer: Mixer,
  tamer: FeedbackTamer,
};

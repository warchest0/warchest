import { Composition } from "remotion";
import { FPS, SIZE } from "./common";
import { Earn, Ranks, Siege, TEASER1, TEASER2, TEASER3, TEASER4, TheChest } from "./teasers";
import { VH, Vertical } from "./vertical";
import { COUNT_D, Countdown, HANDS_D, HFPS, Hands, MANIFESTO_D, Manifesto, RUSH_D, Rush, SIEGE_D, SiegeCut } from "./hype";

const HYPE = [["05-manifesto", Manifesto, MANIFESTO_D], ["06-rank-rush", Rush, RUSH_D], ["07-siege-cut", SiegeCut, SIEGE_D], ["08-sellers-pay", Hands, HANDS_D]] as const;
import { BOOT_D, Boot, RANKUP_D, RankUp, SIEGE_T_D, SiegeLog, TFPS } from "./terminal";
const TERM = [["09-boot", Boot, BOOT_D], ["10-siege-log", SiegeLog, SIEGE_T_D], ["11-rank-up", RankUp, RANKUP_D]] as const;
const FORMATS = [["", SIZE], ["-vertical", VH]] as const;

const V1 = () => <Vertical Teaser={TheChest} />;
const V2 = () => <Vertical Teaser={Ranks} />;
const V3 = () => <Vertical Teaser={Siege} />;
const V4 = () => <Vertical Teaser={Earn} />;

export const Root = () => (
  <>
    <Composition id="01-the-chest" component={TheChest} durationInFrames={Math.round(TEASER1 * FPS)} fps={FPS} width={SIZE} height={SIZE} />
    <Composition id="02-ranks" component={Ranks} durationInFrames={Math.round(TEASER2 * FPS)} fps={FPS} width={SIZE} height={SIZE} />
    <Composition id="03-siege" component={Siege} durationInFrames={Math.round(TEASER3 * FPS)} fps={FPS} width={SIZE} height={SIZE} />
    <Composition id="04-earn" component={Earn} durationInFrames={Math.round(TEASER4 * FPS)} fps={FPS} width={SIZE} height={SIZE} />
    <Composition id="01-the-chest-vertical" component={V1} durationInFrames={Math.round(TEASER1 * FPS)} fps={FPS} width={SIZE} height={VH} />
    <Composition id="02-ranks-vertical" component={V2} durationInFrames={Math.round(TEASER2 * FPS)} fps={FPS} width={SIZE} height={VH} />
    <Composition id="03-siege-vertical" component={V3} durationInFrames={Math.round(TEASER3 * FPS)} fps={FPS} width={SIZE} height={VH} />
    <Composition id="04-earn-vertical" component={V4} durationInFrames={Math.round(TEASER4 * FPS)} fps={FPS} width={SIZE} height={VH} />
    {HYPE.flatMap(([id, C, d]) => FORMATS.map(([sfx, h]) => <Composition key={id + sfx} id={id + sfx} component={C} durationInFrames={d} fps={HFPS} width={SIZE} height={h} />))}
    {TERM.flatMap(([id, C, d]) => FORMATS.map(([sfx, h]) => <Composition key={id + sfx} id={id + sfx} component={C} durationInFrames={d} fps={TFPS} width={SIZE} height={h} />))}
    {[7, 6, 5, 4, 3, 2, 1].flatMap((n) => FORMATS.map(([sfx, h]) => <Composition key={n + sfx} id={`t-${n}${sfx}`} component={Countdown} defaultProps={{ days: n }} durationInFrames={COUNT_D} fps={HFPS} width={SIZE} height={h} />))}
  </>
);

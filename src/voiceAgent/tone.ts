import type { TurnInput } from './voicePrompt';

/**
 * How often the voice agent is invited to joke (`voiceAgent.humor`). A model left to decide by
 * itself either jokes in every reply or never, and settles into one mood and one kind of joke: the
 * host rolls the dice instead and tells it, turn by turn, in `<tone>`.
 */
export type Humor = 'off' | 'occasional' | 'often';

/** Moods the voice drifts between when nothing in particular happens. */
const EVERYDAY_MOODS = ['relaxed', 'wry', 'cheerful', 'thoughtful', 'playful'] as const;

export type Mood = (typeof EVERYDAY_MOODS)[number] | 'sober' | 'pleased' | 'tired';

/** Kinds of aside, worded for the model: the attribute value is all it sees. */
const ASIDES = [
    'dry understatement',
    'a pun on a name in the code or in what was said',
    'a cold joke: a deliberately flat one-liner',
    'mock gravity: treat a small thing as a grave matter',
    'self-mockery about being a voice in a box',
    'a wry remark about the code, the tests or the tools',
] as const;

/** Needs a conversation to call back to. */
const CALLBACK = 'a callback to something said earlier in this conversation';
const CALLBACK_AFTER_TURNS = 4;

const ASIDE_CHANCE: Record<Exclude<Humor, 'off'>, number> = { occasional: 0.3, often: 0.55 };
/** Chance per turn that the everyday mood moves on: slow enough to feel like a mood, not noise. */
const MOOD_DRIFT = 0.3;
/** Late at night, the chance a drifting mood lands on tired. */
const TIRED_AT_NIGHT = 0.35;
/** Turns an error keeps the voice sober. */
const SOBER_TURNS = 2;

export interface Tone {
    mood: Mood;
    /** Coarse local time of day: material for small talk, and why the voice may be tired. */
    time: 'morning' | 'afternoon' | 'evening' | 'late night';
    /** Invites one brief aside of this kind; absent: no jokes this turn. */
    aside?: string;
}

/**
 * Rolls the voice agent's tone for each turn: a mood that drifts and reacts to what happened
 * (an error sobers it for a couple of turns, finished work pleases it once), and now and then an
 * invitation to one aside of a random kind. Never an aside on a turn that carries something the
 * user must act on or hear straight, nor two turns running.
 */
export class ToneDial {
    private _everyday: Mood = 'relaxed';
    private _sober = 0;
    private _turns = 0;
    private _asideLast = false;

    constructor(
        private readonly _random: () => number = Math.random,
        private readonly _now: () => Date = () => new Date(),
    ) {}

    /** The tone for the turn `input` builds; undefined with humor off, which leaves the tone out. */
    next(input: TurnInput, humor: Humor): Tone | undefined {
        if (humor === 'off') {
            return undefined;
        }
        this._turns++;
        const time = timeOfDay(this._now().getHours());
        const event = turnEvent(input);
        if (event === 'error') {
            this._sober = SOBER_TURNS;
        }
        if (this._random() < MOOD_DRIFT) {
            this._everyday = this._drift(time);
        }
        let mood: Mood = this._everyday;
        if (this._sober > 0) {
            this._sober--;
            mood = 'sober';
        } else if (event === 'done') {
            mood = 'pleased';
        }
        const invite = !this._asideLast && mood !== 'sober' && !isSerious(input) && this._random() < ASIDE_CHANCE[humor];
        this._asideLast = invite;
        if (!invite) {
            return { mood, time };
        }
        return { mood, time, aside: pick(this._turns > CALLBACK_AFTER_TURNS ? [...ASIDES, CALLBACK] : ASIDES, this._random) };
    }

    private _drift(time: Tone['time']): Mood {
        if (time === 'late night' && this._random() < TIRED_AT_NIGHT) {
            return 'tired';
        }
        const others = EVERYDAY_MOODS.filter((mood) => mood !== this._everyday);
        return pick(others, this._random);
    }
}

/** The `<tone>` block for a turn message. */
export function toneBlock(tone: Tone): string {
    return `<tone mood="${tone.mood}" time="${tone.time}"${tone.aside ? ` aside="${tone.aside}"` : ''}/>`;
}

/** Something the user has to answer, approve or hear straight: no joke belongs next to it. */
function isSerious(input: TurnInput): boolean {
    const { trigger } = input;
    return (
        input.requests.length > 0 ||
        input.proposals.length > 0 ||
        (input.heldApprovals?.length ?? 0) > 0 ||
        (input.settledApprovals ?? []).some((settled) => settled.outcome !== 'done') ||
        (input.settledProposals ?? []).some((settled) => settled.outcome === 'failed') ||
        input.pendingDelete !== undefined ||
        input.interrupted !== undefined ||
        // A stopped TUI may be waiting on an approval only its screen shows.
        (trigger.kind === 'proactive' &&
            (trigger.observation === 'error' || trigger.observation === 'needs_input' || trigger.observation === 'approval' || trigger.observation === 'stopped'))
    );
}

function turnEvent(input: TurnInput): 'error' | 'done' | undefined {
    const { trigger } = input;
    if (
        (trigger.kind === 'proactive' && trigger.observation === 'error') ||
        (input.settledApprovals ?? []).some((settled) => settled.outcome === 'failed')
    ) {
        return 'error';
    }
    return trigger.kind === 'proactive' && trigger.observation === 'done' ? 'done' : undefined;
}

function timeOfDay(hour: number): Tone['time'] {
    if (hour >= 5 && hour < 12) {
        return 'morning';
    }
    if (hour >= 12 && hour < 18) {
        return 'afternoon';
    }
    return hour >= 18 && hour < 22 ? 'evening' : 'late night';
}

function pick<T>(items: readonly T[], random: () => number): T {
    return items[Math.min(items.length - 1, Math.floor(random() * items.length))];
}

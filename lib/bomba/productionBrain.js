// FILE: lib/bomba/productionBrain.js

/**
 * BOMBA AI — Production Brain
 *
 * Central production state and dependency system.
 *
 * IMPORTANT:
 * - Manages production state only.
 * - Does not generate video, voice, images, or music.
 * - Does not call external APIs.
 * - Does not access Cloudinary or FFmpeg.
 * - Does not save data to Supabase.
 *
 * Production flow:
 *
 * IDEA
 * STORY
 * CHARACTERS
 * DIALOGUE
 * VOICES
 * SCENES
 * SHOTS
 * VIDEO
 * SOUND
 * TIMELINE
 * PREVIEW
 * EXPORT
 */

export const BOMBA_STAGES = [
  "idea",
  "story",
  "characters",
  "dialogue",
  "voices",
  "scenes",
  "shots",
  "video",
  "sound",
  "timeline",
  "preview",
  "export",
];

export const BOMBA_STATUS = {
  PENDING: "pending",
  READY: "ready",
  PROCESSING: "processing",
  COMPLETED: "completed",
  FAILED: "failed",
};

/**
 * Create an empty stage.
 */
function createStage(
  status = BOMBA_STATUS.PENDING
) {
  return {
    status,
    data: null,
    updatedAt: null,
    error: null,
  };
}

/**
 * Generate a project ID.
 */
function createProjectId() {
  return `bomba-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/**
 * Validate a production stage name.
 */
function assertValidStage(stage) {
  if (!BOMBA_STAGES.includes(stage)) {
    throw new Error(
      `Unknown BOMBA production stage: ${stage}`
    );
  }
}

/**
 * Validate the production object.
 */
function assertProduction(production) {
  if (
    !production ||
    typeof production !== "object"
  ) {
    throw new Error(
      "Production state is required."
    );
  }
}

/**
 * Create a new production.
 */
export function createProduction(
  initialIdea = ""
) {
  const now = new Date().toISOString();

  const safeIdea =
    typeof initialIdea === "string"
      ? initialIdea.trim()
      : "";

  return {
    version: 1,

    project: {
      id: createProjectId(),
      title: safeIdea.slice(0, 120),
      createdAt: now,
      updatedAt: now,
    },

    idea: {
      status: safeIdea
        ? BOMBA_STATUS.READY
        : BOMBA_STATUS.PENDING,

      data: safeIdea
        ? {
            prompt: safeIdea,
          }
        : null,

      updatedAt: safeIdea
        ? now
        : null,

      error: null,
    },

    story: createStage(),
    characters: createStage(),
    dialogue: createStage(),
    voices: createStage(),
    scenes: createStage(),
    shots: createStage(),
    video: createStage(),
    sound: createStage(),
    timeline: createStage(),
    preview: createStage(),
    export: createStage(),

    dependencies: {
      idea: [],

      story: [
        "idea",
      ],

      characters: [
        "story",
      ],

      dialogue: [
        "story",
        "characters",
      ],

      voices: [
        "dialogue",
        "characters",
      ],

      scenes: [
        "story",
        "characters",
        "dialogue",
      ],

      shots: [
        "scenes",
      ],

      video: [
        "shots",
        "characters",
      ],

      sound: [
        "scenes",
        "dialogue",
      ],

      timeline: [
        "video",
        "voices",
        "sound",
      ],

      preview: [
        "timeline",
      ],

      export: [
        "preview",
        "timeline",
      ],
    },

    history: [],
  };
}

/**
 * Record a state change in production history.
 */
function appendHistory(
  production,
  entry
) {
  const history = Array.isArray(
    production.history
  )
    ? production.history
    : [];

  return [
    ...history,
    entry,
  ].slice(-500);
}

/**
 * Update one production stage.
 */
export function updateStage(
  production,
  stage,
  update = {}
) {
  assertProduction(production);
  assertValidStage(stage);

  if (
    !update ||
    typeof update !== "object" ||
    Array.isArray(update)
  ) {
    throw new Error(
      "Stage update must be an object."
    );
  }

  const now = new Date().toISOString();

  const previousStage =
    production[stage] || createStage();

  const nextStage = {
    ...previousStage,
    ...update,
    updatedAt: now,
  };

  const nextHistory = appendHistory(
    production,
    {
      type: "stage_update",
      stage,
      timestamp: now,
      previousStatus:
        previousStage.status || null,
      nextStatus:
        nextStage.status,
    }
  );

  return {
    ...production,

    [stage]: nextStage,

    project: {
      ...(production.project || {}),
      updatedAt: now,
    },

    history: nextHistory,
  };
}

/**
 * Get direct and indirect downstream stages.
 *
 * Results follow BOMBA_STAGES order.
 */
export function getAffectedStages(
  production,
  changedStage
) {
  assertProduction(production);
  assertValidStage(changedStage);

  const affected = new Set();

  const dependencies =
    production.dependencies || {};

  function collect(stage) {
    for (const candidate of BOMBA_STAGES) {
      if (affected.has(candidate)) {
        continue;
      }

      const requiredStages =
        dependencies[candidate] || [];

      if (
        requiredStages.includes(stage)
      ) {
        affected.add(candidate);
        collect(candidate);
      }
    }
  }

  collect(changedStage);

  return BOMBA_STAGES.filter(
    (stage) => affected.has(stage)
  );
}

/**
 * Reset all stages affected by a change.
 *
 * The changed stage itself is preserved.
 */
export function invalidateAffectedStages(
  production,
  changedStage
) {
  assertProduction(production);
  assertValidStage(changedStage);

  const affected =
    getAffectedStages(
      production,
      changedStage
    );

  let nextProduction = production;

  for (const stage of affected) {
    nextProduction = updateStage(
      nextProduction,
      stage,
      {
        status: BOMBA_STATUS.PENDING,
        data: null,
        error: null,
      }
    );
  }

  return nextProduction;
}

/**
 * Change a stage's data.
 *
 * All downstream stages are invalidated.
 */
export function changeProductionStage(
  production,
  stage,
  data
) {
  assertProduction(production);
  assertValidStage(stage);

  let nextProduction = updateStage(
    production,
    stage,
    {
      status: BOMBA_STATUS.READY,
      data,
      error: null,
    }
  );

  nextProduction =
    invalidateAffectedStages(
      nextProduction,
      stage
    );

  return nextProduction;
}

/**
 * Check whether a stage's dependencies are ready.
 */
function areDependenciesReady(
  production,
  stage
) {
  const dependencies =
    production.dependencies?.[stage] || [];

  return dependencies.every(
    (dependency) => {
      const dependencyStage =
        production[dependency];

      return Boolean(
        dependencyStage &&
        (
          dependencyStage.status ===
            BOMBA_STATUS.READY ||
          dependencyStage.status ===
            BOMBA_STATUS.COMPLETED
        )
      );
    }
  );
}

/**
 * Check whether a stage can start.
 *
 * Only PENDING stages can start.
 *
 * READY means data already exists.
 * PROCESSING means work is already running.
 * COMPLETED means work has finished.
 * FAILED requires an explicit retry/reset.
 */
export function canRunStage(
  production,
  stage
) {
  if (
    !production ||
    !BOMBA_STAGES.includes(stage)
  ) {
    return false;
  }

  const currentStage =
    production[stage];

  if (!currentStage) {
    return false;
  }

  if (
    currentStage.status !==
    BOMBA_STATUS.PENDING
  ) {
    return false;
  }

  return areDependenciesReady(
    production,
    stage
  );
}

/**
 * Find the next PENDING stage whose
 * dependencies are ready.
 */
export function getNextProductionStage(
  production
) {
  assertProduction(production);

  for (const stage of BOMBA_STAGES) {
    if (
      canRunStage(
        production,
        stage
      )
    ) {
      return stage;
    }
  }

  return null;
}

/**
 * Get a summary of all production stages.
 */
export function getProductionSummary(
  production
) {
  const summary = {
    completed: [],
    ready: [],
    processing: [],
    pending: [],
    failed: [],
  };

  if (!production) {
    return summary;
  }

  for (const stage of BOMBA_STAGES) {
    const status =
      production[stage]?.status;

    if (
      Object.prototype.hasOwnProperty.call(
        summary,
        status
      )
    ) {
      summary[status].push(stage);
    }
  }

  return summary;
}

/**
 * Return a detached copy of production state.
 */
export function getProductionState(
  production
) {
  if (!production) {
    return null;
  }

  return JSON.parse(
    JSON.stringify(production)
  );
}

/**
 * Create a Director decision.
 */
export function createDirectorDecision(
  production
) {
  if (!production) {
    return {
      nextStage: null,

      summary:
        getProductionSummary(null),

      message:
        "BOMBA Director has no active production.",
    };
  }

  const nextStage =
    getNextProductionStage(
      production
    );

  return {
    nextStage,

    summary:
      getProductionSummary(
        production
      ),

    message: nextStage
      ? `BOMBA Director recommends working on ${nextStage}.`
      : "BOMBA Director has no pending stage ready to run.",
  };
}
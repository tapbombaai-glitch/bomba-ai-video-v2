// FILE: lib/bomba/productionStore.js

/**
 * BOMBA AI — Production Store
 *
 * Central state bridge for BOMBA production.
 *
 * Responsibilities:
 * - Maintain the current in-memory production.
 * - Validate stage transitions.
 * - Notify subscribers about state changes.
 * - Coordinate with Production Brain.
 *
 * This module does not call external APIs.
 * This module does not generate media.
 * This module does not persist data to Supabase.
 */

import {
  createProduction,
  updateStage,
  changeProductionStage,
  invalidateAffectedStages,
  getAffectedStages,
  getNextProductionStage,
  canRunStage,
  getProductionSummary,
  getProductionState,
  createDirectorDecision,
  BOMBA_STATUS,
  BOMBA_STAGES,
} from "./productionBrain";

let currentProduction = null;

const subscribers = new Set();

/**
 * Notify subscribers with a detached state snapshot.
 */
function notifySubscribers() {
  const snapshot =
    getProductionState(currentProduction);

  for (const subscriber of subscribers) {
    try {
      subscriber(snapshot);
    } catch (error) {
      console.error(
        "BOMBA Production Store subscriber error:",
        error
      );
    }
  }
}

/**
 * Ensure a production exists.
 */
function ensureProduction() {
  if (!currentProduction) {
    throw new Error(
      "No BOMBA production is initialized."
    );
  }
}

/**
 * Validate a stage name.
 */
function assertValidStage(stage) {
  if (!BOMBA_STAGES.includes(stage)) {
    throw new Error(
      `Unknown BOMBA production stage: ${stage}`
    );
  }
}

/**
 * Validate dependencies before executing a stage.
 */
function assertDependenciesReady(stage) {
  if (!canRunStage(currentProduction, stage)) {
    const currentStatus =
      currentProduction[stage]?.status;

    if (
      currentStatus ===
      BOMBA_STATUS.PROCESSING
    ) {
      throw new Error(
        `The "${stage}" stage is already processing.`
      );
    }

    if (
      currentStatus ===
      BOMBA_STATUS.FAILED
    ) {
      throw new Error(
        `The "${stage}" stage has failed. Reset it before retrying.`
      );
    }

    if (
      currentStatus ===
      BOMBA_STATUS.READY ||
      currentStatus ===
      BOMBA_STATUS.COMPLETED
    ) {
      throw new Error(
        `The "${stage}" stage already has a result.`
      );
    }

    throw new Error(
      `The "${stage}" stage cannot run yet. Check that all dependencies are ready.`
    );
  }
}

/**
 * Subscribe to production updates.
 */
export function subscribeToProduction(subscriber) {
  if (typeof subscriber !== "function") {
    throw new Error(
      "Production subscriber must be a function."
    );
  }

  subscribers.add(subscriber);

  try {
    subscriber(
      getProductionState(currentProduction)
    );
  } catch (error) {
    subscribers.delete(subscriber);
    throw error;
  }

  return () => {
    subscribers.delete(subscriber);
  };
}

/**
 * Create a new production.
 */
export function initializeProduction(
  initialIdea = ""
) {
  currentProduction =
    createProduction(initialIdea);

  notifySubscribers();

  return getProductionState(
    currentProduction
  );
}

/**
 * Replace the current production state.
 */
export function setProduction(production) {
  if (
    !production ||
    typeof production !== "object"
  ) {
    throw new Error(
      "Production state is required."
    );
  }

  currentProduction =
    getProductionState(production);

  notifySubscribers();

  return getProductionState(
    currentProduction
  );
}

/**
 * Get the current production.
 */
export function getProduction() {
  return getProductionState(
    currentProduction
  );
}

/**
 * Check whether a production exists.
 */
export function hasProduction() {
  return Boolean(currentProduction);
}

/**
 * Clear the current production.
 */
export function clearProduction() {
  currentProduction = null;

  notifySubscribers();

  return null;
}

/**
 * Update a stage without automatically invalidating dependents.
 */
export function updateProductionStage(
  stage,
  update = {}
) {
  ensureProduction();
  assertValidStage(stage);

  currentProduction =
    updateStage(
      currentProduction,
      stage,
      update
    );

  notifySubscribers();

  return getProductionState(
    currentProduction
  );
}

/**
 * Change stage data and invalidate downstream stages.
 */
export function changeStage(
  stage,
  data
) {
  ensureProduction();
  assertValidStage(stage);

  currentProduction =
    changeProductionStage(
      currentProduction,
      stage,
      data
    );

  notifySubscribers();

  return getProductionState(
    currentProduction
  );
}

/**
 * Invalidate downstream stages.
 */
export function invalidateStage(stage) {
  ensureProduction();
  assertValidStage(stage);

  currentProduction =
    invalidateAffectedStages(
      currentProduction,
      stage
    );

  notifySubscribers();

  return getProductionState(
    currentProduction
  );
}

/**
 * Get downstream stages affected by a change.
 */
export function getAffected(stage) {
  ensureProduction();

  return getAffectedStages(
    currentProduction,
    stage
  );
}

/**
 * Get the next stage ready to run.
 */
export function getNextStage() {
  ensureProduction();

  return getNextProductionStage(
    currentProduction
  );
}

/**
 * Check whether a stage can run.
 */
export function canRun(stage) {
  ensureProduction();

  return canRunStage(
    currentProduction,
    stage
  );
}

/**
 * Get production summary.
 */
export function getSummary() {
  return getProductionSummary(
    currentProduction
  );
}

/**
 * Get Director decision.
 */
export function getDirectorDecision() {
  ensureProduction();

  return createDirectorDecision(
    currentProduction
  );
}

/**
 * Start a stage.
 *
 * The stage must be PENDING and all its
 * dependencies must be READY or COMPLETED.
 */
export function startStage(stage) {
  ensureProduction();
  assertValidStage(stage);

  assertDependenciesReady(stage);

  currentProduction =
    updateStage(
      currentProduction,
      stage,
      {
        status:
          BOMBA_STATUS.PROCESSING,
        error: null,
      }
    );

  notifySubscribers();

  return getProductionState(
    currentProduction
  );
}

/**
 * Complete a stage.
 *
 * A stage may complete only if it is currently
 * PROCESSING and its dependencies remain valid.
 */
export function completeStage(
  stage,
  data = null
) {
  ensureProduction();
  assertValidStage(stage);

  const currentStage =
    currentProduction[stage];

  if (
    currentStage.status !==
    BOMBA_STATUS.PROCESSING
  ) {
    throw new Error(
      `Cannot complete "${stage}" because it is not processing.`
    );
  }

  const dependenciesReady =
    (
      currentProduction.dependencies?.[stage] || []
    ).every((dependency) => {
      const dependencyStage =
        currentProduction[dependency];

      return Boolean(
        dependencyStage &&
        (
          dependencyStage.status ===
            BOMBA_STATUS.READY ||
          dependencyStage.status ===
            BOMBA_STATUS.COMPLETED
        )
      );
    });

  if (!dependenciesReady) {
    throw new Error(
      `Cannot complete "${stage}" because one or more dependencies are no longer ready.`
    );
  }

  currentProduction =
    updateStage(
      currentProduction,
      stage,
      {
        status:
          BOMBA_STATUS.COMPLETED,
        data,
        error: null,
      }
    );

  notifySubscribers();

  return getProductionState(
    currentProduction
  );
}

/**
 * Mark a stage as failed.
 */
export function failStage(
  stage,
  error
) {
  ensureProduction();
  assertValidStage(stage);

  currentProduction =
    updateStage(
      currentProduction,
      stage,
      {
        status:
          BOMBA_STATUS.FAILED,

        error:
          error instanceof Error
            ? error.message
            : String(
                error || "Unknown error."
              ),
      }
    );

  notifySubscribers();

  return getProductionState(
    currentProduction
  );
}

/**
 * Reset a stage so it can be retried.
 *
 * Downstream stages are also invalidated because
 * their results may depend on this stage.
 */
export function resetStage(stage) {
  ensureProduction();
  assertValidStage(stage);

  currentProduction =
    updateStage(
      currentProduction,
      stage,
      {
        status:
          BOMBA_STATUS.PENDING,
        data: null,
        error: null,
      }
    );

  currentProduction =
    invalidateAffectedStages(
      currentProduction,
      stage
    );

  notifySubscribers();

  return getProductionState(
    currentProduction
  );
}

/**
 * Export production state as JSON.
 */
export function exportProductionState() {
  ensureProduction();

  return JSON.stringify(
    currentProduction,
    null,
    2
  );
}

/**
 * Import production state from JSON.
 */
export function importProductionState(json) {
  if (!json) {
    throw new Error(
      "Production JSON is required."
    );
  }

  let parsed;

  try {
    parsed =
      typeof json === "string"
        ? JSON.parse(json)
        : json;
  } catch {
    throw new Error(
      "Invalid production JSON."
    );
  }

  setProduction(parsed);

  return getProductionState(
    currentProduction
  );
}
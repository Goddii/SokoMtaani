import type { Transition } from "motion/react"

/**
 * Shared easing curves (from emil-design-eng principles).
 * - standard: strong ease-out for UI entry / press feedback.
 * - emphasized: ease-in-out for on-screen movement.
 * - snappy: very short for micro-interactions.
 */
export const easing = {
  standard: [0.23, 1, 0.32, 1],
  emphasized: [0.77, 0, 0.175, 1],
  snappy: [0.3, 0, 0.5, 1],
} as const

/**
 * Default transition applied globally via <MotionConfig>.
 * UI animations stay under 300 ms (emil-design-eng: perceived-performance rule).
 */
export const defaultTransition: Transition = {
  duration: 0.25,
  ease: easing.standard,
}

/**
 * Stagger delay between children in a group (e.g. list, grid).
 */
export const staggerDelay = 0.05

/**
 * Spring config for playful / attention animations (e.g. error pill, success).
 */
export const springConfig: Transition = {
  type: "spring",
  stiffness: 400,
  damping: 25,
}

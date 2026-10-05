import { motion, useReducedMotion } from 'motion/react'
import { easing, staggerDelay, springConfig } from '../../lib/motion'
import { cn } from '../../lib/utils'

interface FallingTextProps {
  text: string
  className?: string
}

/**
 * Lightweight word-level falling-text animation.
 * Each word drops from above with a spring bounce, staggered for a
 * cascading effect — inspired by React Bits' Falling Text but built
 * with the project's existing motion stack (motion/react) instead of
 * pulling in matter-js.
 */
export function FallingText({ text, className }: FallingTextProps) {
  const shouldReduceMotion = useReducedMotion()
  const words = text.split(' ')

  return (
    <motion.div
      className={cn('flex flex-wrap justify-center gap-x-1', className)}
      initial="hidden"
      animate="visible"
      variants={{
        hidden: {},
        visible: {
          transition: {
            staggerChildren: shouldReduceMotion ? 0 : staggerDelay,
            delayChildren: shouldReduceMotion ? 0 : staggerDelay * 2,
          },
        },
      }}
    >
      {words.map((word, i) => (
        <motion.span
          key={`${word}-${i}`}
          className="inline-block"
          variants={{
            hidden: {
              y: shouldReduceMotion ? 0 : -40,
              opacity: shouldReduceMotion ? 1 : 0,
            },
            visible: {
              y: 0,
              opacity: 1,
              transition: {
                y: springConfig,
                opacity: {
                  duration: 0.3,
                  ease: easing.standard,
                },
              },
            },
          }}
        >
          {word}
        </motion.span>
      ))}
    </motion.div>
  )
}

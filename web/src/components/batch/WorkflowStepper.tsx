import type { Stage, WorkflowProgress } from './workflowProgress'
import './batch.css'

const MARKS: Record<Stage['state'], string> = {
  done: '✓',
  current: '▸',
  todo: '·',
  blocked: '!',
}

const STATE_WORDS: Record<Stage['state'], string> = {
  done: 'done',
  current: 'current step',
  todo: 'not started',
  blocked: 'needs attention',
}

/**
 * The five-stage spine shown at the top of every workflow page.
 *
 * It is deliberately read-only: clicking a stage never navigates, because the
 * stages are not all on one route and half of them are gated by the server.
 * Its job is orientation — "where am I, what is next, what is blocking".
 */
export function WorkflowStepper({ progress }: { progress: WorkflowProgress }) {
  return (
    <nav className="workflow-stepper" aria-label="Batch progress">
      <ol>
        {progress.stages.map((stage, index) => (
          <li
            key={stage.id}
            className={`workflow-stage is-${stage.state}`}
            data-stage={stage.id}
            aria-current={stage.state === 'current' ? 'step' : undefined}
          >
            <span className="workflow-mark" aria-hidden="true">
              {MARKS[stage.state]}
            </span>
            <span className="workflow-text">
              <strong>
                {index + 1}. {stage.label}
              </strong>
              <span>{stage.detail}</span>
            </span>
            <span className="sr-only">{STATE_WORDS[stage.state]}</span>
          </li>
        ))}
      </ol>
    </nav>
  )
}

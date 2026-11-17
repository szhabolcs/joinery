/**
 * "Ask ▾ Model": a split button. The "Ask" half acts; the model half opens
 * a Base UI menu over the server's models (`useAgentModels`). The pick is shared and remembered
 * (`lib/agentModel.ts`), so every Ask button shows the same model, unless
 * the caller owns the pick (`model` + `onModelChange`), as the reading-order
 * "Generate with" button does.
 */
import { Menu } from '@base-ui-components/react/menu';
import type { AgentModel } from '@joinery/core';
import { Check, ChevronDown } from 'lucide-react';
import { useRef } from 'react';
import { agentModelLabel, setAgentModel, useAgentModel, useAgentModels } from '../lib/agentModel.ts';
import { Hint, MENU_POPUP_CLASS, POPUP_ITEM_CLASS, Tick } from './controls.tsx';

export function AskButton({
  onAsk,
  disabled = false,
  title,
  onPicked,
  label: actionLabel = 'Ask',
  model: controlledModel,
  onModelChange,
}: {
  onAsk: () => void;
  disabled?: boolean;
  /** Tooltip for the "Ask" half; `{model}` is replaced with the picked model's label. */
  title: string;
  /** Called once the menu has closed after a pick, e.g. to return focus to a textarea. */
  onPicked?: () => void;
  /** The action half's text. */
  label?: string;
  /** A caller-owned pick; without it the shared Ask pick is used. */
  model?: AgentModel;
  onModelChange?: (model: AgentModel) => void;
}): React.JSX.Element {
  const sharedModel = useAgentModel();
  const model = controlledModel ?? sharedModel;
  const models = useAgentModels();
  const label = agentModelLabel(models, model);
  // Set by a pick, so `onPicked` runs after the menu has handed focus back
  // to its trigger rather than racing it.
  const pickedRef = useRef(false);

  return (
    <div className="relative flex h-[26px] items-stretch rounded-md border bg-chrome-bg-hover text-xs font-medium text-chrome-fg-muted">
      <Hint label={title.replace('{model}', label)}>
        <button
          type="button"
          onClick={onAsk}
          disabled={disabled}
          className="rounded-l-[5px] px-2.5 transition-colors hover:bg-chrome-bg-active hover:text-chrome-fg disabled:opacity-50 disabled:hover:bg-transparent"
        >
          {actionLabel}
        </button>
      </Hint>
      <span className={`my-1.5 w-px bg-chrome-border-strong ${disabled ? 'opacity-50' : ''}`} aria-hidden />
      <Menu.Root
        modal={false}
        onOpenChangeComplete={(open) => {
          if (open || !pickedRef.current) return;
          pickedRef.current = false;
          onPicked?.();
        }}
      >
        <Menu.Trigger
          aria-label={`Model: ${label}. Change model`}
          className={`flex items-center gap-1 whitespace-nowrap rounded-r-[5px] pl-2 pr-1.5 transition-colors hover:bg-chrome-bg-active hover:text-chrome-fg data-popup-open:bg-chrome-bg-active data-popup-open:text-chrome-fg ${disabled ? 'opacity-50' : ''}`}
        >
          {label}
          <ChevronDown size={12} strokeWidth={2} aria-hidden />
        </Menu.Trigger>
        {/* Portaled, so ancestors with `overflow` (the diff view) can't clip it. */}
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="end" sideOffset={4} collisionPadding={8} className="z-50">
            <Menu.Popup className={`${MENU_POPUP_CLASS} min-w-32`}>
              <Menu.RadioGroup
                value={model}
                onValueChange={(m: AgentModel) => {
                  if (onModelChange === undefined) setAgentModel(m);
                  else onModelChange(m);
                  pickedRef.current = true;
                }}
              >
                {models.map((m) => (
                  <Menu.RadioItem
                    key={m.id}
                    value={m.id}
                    closeOnClick
                    className={POPUP_ITEM_CLASS}
                  >
                    <span className="flex-1">{m.label}</span>
                    <Tick>
                      <Menu.RadioItemIndicator>
                        <Check size={12} strokeWidth={2} className="text-chrome-accent" aria-hidden />
                      </Menu.RadioItemIndicator>
                    </Tick>
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}

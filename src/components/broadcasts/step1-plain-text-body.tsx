'use client';

import { ArrowRight } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

interface Step1PlainTextBodyProps {
  bodyText: string;
  onBodyTextChange: (value: string) => void;
  onNext: () => void;
  onBack: () => void;
}

/**
 * Evolution-connected accounts have no template-approval workflow, so
 * step 1 of the wizard is a free-text composer instead of
 * Step1ChooseTemplate's template picker. `{{1}}`/`{{2}}` placeholders
 * are mapped to contact fields in the next step (Step3Personalize),
 * exactly like a template's placeholders are — same
 * resolveVariables()/interpolateBody() machinery underneath, just no
 * Meta template object involved.
 */
export function Step1PlainTextBody({
  bodyText,
  onBodyTextChange,
  onNext,
  onBack,
}: Step1PlainTextBodyProps) {
  const t = useTranslations('Broadcasts.wizard');
  const canContinue = bodyText.trim().length > 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">
          {t('composeText.title')}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('composeText.subtitle')}
        </p>
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">
          {t('composeText.bodyLabel')}
        </label>
        <Textarea
          value={bodyText}
          onChange={(e) => onBodyTextChange(e.target.value)}
          // Literal {{1}}-style placeholders aren't valid ICU — t.raw()
          // bypasses next-intl's parser (see icu-safety.test.ts).
          placeholder={t.raw('composeText.bodyPlaceholder')}
          rows={6}
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
        <p className="mt-1.5 text-xs text-muted-foreground">
          {t.raw('composeText.bodyHint')}
        </p>
      </div>

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button variant="outline" onClick={onBack} className="border-border text-muted-foreground">
          {t('back')}
        </Button>
        <Button
          onClick={onNext}
          disabled={!canContinue}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('next')}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

import { useEffect, type FormEvent } from 'react'
import { Plus, X } from 'lucide-react'
import type { PricingMode } from '../../lib/api'
import type { Category, Unit } from '../../lib/types'
import { Button } from '../../components/ui/Button'
import { Modal } from '../../components/ui/Modal'
import { TextField, SelectField, Segmented } from '../../components/ui/Form'
import { cn } from '../../lib/utils'
import { CATEGORY_OPTIONS, MODE_OPTIONS, UNIT_OPTIONS, type ProductForm } from './productForm'

interface ProductFormModalProps {
  form: ProductForm | null
  onChange: (form: ProductForm) => void
  onClose: () => void
  onSubmit: (e: FormEvent) => void
  saving: boolean
  error: string | null
  /** True when open stock locks the pricing mode and base unit. */
  locked: boolean
}

export function ProductFormModal({ form, onChange, onClose, onSubmit, saving, error, locked }: ProductFormModalProps) {
  // Focus the name field once the dialog is open. A native <dialog> would
  // otherwise focus its first control (the close button).
  const isOpen = form !== null
  useEffect(() => {
    if (isOpen) document.getElementById('product-name-field')?.focus()
  }, [isOpen])

  return (
    <Modal
      open={form !== null}
      onClose={onClose}
      title={form?.id ? `Edit ${form.name}` : 'Add product'}
      description={form?.id ? 'Changes apply to the catalogue immediately.' : 'A new line for the shelf and the till.'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={onSubmit}>
            {form?.id ? 'Save changes' : 'Add product'}
          </Button>
        </>
      }
    >
      {form && (
        <form onSubmit={onSubmit} className="space-y-4">
          <TextField
            label="Product name"
            required
            value={form.name}
            onChange={(e) => onChange({ ...form, name: e.target.value })}
            placeholder="e.g. Red Onions"
            id="product-name-field"
          />

          <Segmented<PricingMode>
            id="pricing-mode"
            label="How is it sold?"
            value={form.pricingMode}
            onChange={(v) => onChange({ ...form, pricingMode: v })}
            options={MODE_OPTIONS}
            disabled={locked}
          />
          {locked && (
            <p className="rounded-lg bg-warning-50 px-3 py-2 text-xs font-semibold text-warning-700">
              This product has open stock on hand — close the open batches (Inventory → Stock batches)
              before changing how it is sold or its base unit.
            </p>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SelectField
              label="Category"
              value={form.category}
              onChange={(e) => onChange({ ...form, category: e.target.value as Category })}
              options={CATEGORY_OPTIONS}
            />
            <div>
              <Segmented<Unit>
                id="base-unit"
                label="Base unit"
                value={form.baseUnit}
                onChange={(v) => onChange({ ...form, baseUnit: v })}
                options={UNIT_OPTIONS}
                disabled={locked}
              />
              {form.pricingMode === 'counted' && (
                <p className="mt-1.5 text-xs leading-relaxed text-ink-500">
                  Sold by count — pick <span className="font-semibold">piece</span> and each option's amount is the number of pieces it takes from stock.
                </p>
              )}
            </div>
          </div>

          {/* Price buttons — fixed prices on the till */}
          <div className="space-y-2 rounded-xl border border-ink-200 p-3">
            <div>
              <p className="text-[13px] font-semibold text-ink-700">
                Price buttons <span className="font-medium text-ink-400">(optional for weighed)</span>
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-ink-500">
                {form.pricingMode === 'counted'
                  ? 'Fixed prices the attendant taps — e.g. “1 @ KSh5”, “3 @ KSh10”. Each option’s amount is the stock it consumes (e.g. 3 pieces), so sales deduct exactly what was sold.'
                  : 'Shortcuts for the till — e.g. “1/4 kg” at KSh40. The exact amount keeps cost/profit math accurate. Leave empty to sell at the flat rate above.'}
              </p>
            </div>

            {form.buttons.length > 0 && (
              <div className="space-y-2">
                {form.buttons.map((button, i) => (
                  <div
                    key={i}
                    className={cn('grid grid-cols-1 gap-2 sm:items-end sm:grid-cols-[minmax(0,1fr)_6.5rem_6rem_2.5rem]')}
                  >
                    <TextField
                      label={i === 0 ? 'Label' : undefined}
                      placeholder={form.pricingMode === 'counted' ? 'e.g. “1 @ KSh5”' : 'e.g. “1/4 kg”'}
                      value={button.label}
                      onChange={(e) =>
                        onChange({
                          ...form,
                          buttons: form.buttons.map((t, j) => (j === i ? { ...t, label: e.target.value } : t)),
                        })
                      }
                    />
                    <TextField
                      label={
                        i === 0 ? (form.pricingMode === 'counted' ? 'Amount (pieces)' : `Amount (${form.baseUnit})`) : undefined
                      }
                      type="number"
                      min="0"
                      step="0.01"
                      inputMode="decimal"
                      placeholder="0"
                      value={button.kgAmount}
                      onChange={(e) =>
                        onChange({
                          ...form,
                          buttons: form.buttons.map((t, j) => (j === i ? { ...t, kgAmount: e.target.value } : t)),
                        })
                      }
                    />
                    <TextField
                      label={i === 0 ? 'Price (KES)' : undefined}
                      type="number"
                      min="0"
                      step="0.5"
                      inputMode="decimal"
                      placeholder="0"
                      value={button.price}
                      onChange={(e) =>
                        onChange({
                          ...form,
                          buttons: form.buttons.map((t, j) => (j === i ? { ...t, price: e.target.value } : t)),
                        })
                      }
                    />
                    <button
                      type="button"
                      onClick={() => onChange({ ...form, buttons: form.buttons.filter((_, j) => j !== i) })}
                      aria-label={`Remove price button ${button.label || i + 1}`}
                      className="flex h-10 w-10 items-center justify-center self-end justify-self-start rounded-lg border border-ink-200 text-ink-400 transition-colors hover:border-danger-200 hover:bg-danger-50 hover:text-danger-600 sm:justify-self-auto"
                    >
                      <X className="size-4" aria-hidden />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <button
              type="button"
              onClick={() => onChange({ ...form, buttons: [...form.buttons, { label: '', kgAmount: '', price: '' }] })}
              className="flex h-10 w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-ink-300 text-[13px] font-semibold text-ink-600 transition-colors hover:border-brand-500 hover:bg-brand-50 hover:text-brand-700"
            >
              <Plus className="size-4" aria-hidden />
              Add price button
            </button>
          </div>

          <div className={cn('grid gap-4', form.pricingMode === 'weighed' ? 'grid-cols-2' : 'grid-cols-1')}>
            {form.pricingMode === 'weighed' && (
              <TextField
                label="Selling price (KES)"
                required
                type="number"
                min="0"
                step="0.5"
                inputMode="decimal"
                value={form.sellPrice}
                onChange={(e) => onChange({ ...form, sellPrice: e.target.value })}
                placeholder="0"
              />
            )}
            <TextField
              label="Low-stock alert threshold"
              required
              type="number"
              min="0"
              step="0.5"
              inputMode="decimal"
              value={form.lowStockThreshold}
              onChange={(e) => onChange({ ...form, lowStockThreshold: e.target.value })}
              placeholder="0"
            />
          </div>
          <p className="rounded-lg bg-ink-50 px-3 py-2 text-[13px] text-ink-500">
            {form.pricingMode === 'counted'
              ? 'Every option takes its exact amount from stock — record a batch under Inventory when a delivery arrives so cost and stock stay accurate.'
              : 'Stock on hand is tracked through stock batches — record a new batch under Inventory when a delivery arrives.'}
          </p>
          {error && (
            <p className="rounded-lg bg-danger-50 px-3 py-2 text-[13px] font-semibold text-danger-700" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </Modal>
  )
}

import { Boxes, LayoutDashboard, Package, Receipt, ShoppingCart, Trash2, Users, type LucideIcon } from 'lucide-react'

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  end?: boolean
  pos?: boolean
  /** Hidden from attendants — only the owner sees this item. */
  ownerOnly?: boolean
}

export interface NavSection {
  section: string
  items: NavItem[]
}

export const NAV: NavSection[] = [
  {
    section: 'Till',
    items: [{ to: '/pos', label: 'Point of Sale', icon: ShoppingCart, pos: true }],
  },
  {
    section: 'Sales',
    items: [{ to: '/sales', label: 'Sales', icon: Receipt, ownerOnly: true }],
  },
  {
    section: 'Goods',
    items: [
      { to: '/products', label: 'Products', icon: Package, ownerOnly: true },
      { to: '/batches', label: 'Stock batches', icon: Boxes, ownerOnly: true },
      { to: '/wastage', label: 'Wastage', icon: Trash2 },
    ],
  },
  {
    section: 'Owner',
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true, ownerOnly: true },
      { to: '/attendants', label: 'Attendants', icon: Users, ownerOnly: true },
    ],
  },
]

/**
 * NAV filtered for a role. Owners see everything; attendants only get the till
 * and wastage (they log losses during their shift). Empty sections are dropped.
 */
export function navForRole(role: 'owner' | 'attendant'): NavSection[] {
  if (role === 'owner') return NAV
  return NAV.map((section) => ({
    section: section.section,
    items: section.items.filter((item) => !item.ownerOnly),
  })).filter((section) => section.items.length > 0)
}

export const SHOP_NAME = 'SokoMtaani'
export const SHOP_SUB = 'Duka la Mboga · Nairobi'

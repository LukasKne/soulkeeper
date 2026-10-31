import type { SelectHTMLAttributes } from 'react'
import Chevron from './Chevron'

export default function SelectControl({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <span className="styled-select"><select {...props}>{children}</select><Chevron className="select-chevron"/></span>
}

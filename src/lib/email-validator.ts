import dns from 'node:dns/promises'

// Known disposable/temporary email domains
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'tempmail.com', 'throwaway.email',
  '10minutemail.com', 'temp-mail.org', 'fakeinbox.com', 'getnada.com',
  'yopmail.com', 'sharklasers.com', 'guerrillamailblock.com', 'armyspy.com',
  'cuvox.de', 'dayrep.com', 'einrot.com', 'fleckens.hu', 'gustr.com',
  'jourrapide.com', 'rhyta.com', 'superrito.com', 'teleworm.us',
  'junk.com', 'spam.com', 'trash.com', 'dump.com', 'fake.com',
  'nonsense.com', 'nothing.com', 'nobody.com', 'nowhere.com',
  'example.com', 'example.org', 'example.net', 'test.com', 'test.org',
])

// Role-based email prefixes (less likely to be a real person)
const ROLE_PREFIXES = new Set([
  'info', 'support', 'admin', 'administrator', 'webmaster', 'postmaster',
  'sales', 'contact', 'help', 'service', 'office', 'mail', 'email',
  'root', 'abuse', 'security', 'noreply', 'no-reply', 'donotreply',
  'marketing', 'team', 'hello', 'enquiries', 'inquiry', 'general',
])

export interface ValidationResult {
  email: string
  valid: boolean
  reason: string
  category: 'valid' | 'invalid_syntax' | 'disposable' | 'role_based' | 'no_mx' | 'catch_all' | 'timeout'
  mxFound?: boolean
}

// Check if email has valid syntax
export function isValidSyntax(email: string): boolean {
  const regex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/
  return regex.test(email)
}

// Check if domain is disposable
export function isDisposable(domain: string): boolean {
  return DISPOSABLE_DOMAINS.has(domain.toLowerCase())
}

// Check if email is role-based (info@, support@, etc.)
export function isRoleBased(email: string): boolean {
  const prefix = email.split('@')[0]?.toLowerCase()
  return prefix ? ROLE_PREFIXES.has(prefix) : false
}

// Check if domain has MX records (email can receive mail)
export async function hasMxRecords(domain: string): Promise<{ found: boolean; timeout: boolean }> {
  try {
    const records = await dns.resolveMx(domain)
    return { found: records.length > 0, timeout: false }
  } catch (e: any) {
    if (e.code === 'ENOTFOUND' || e.code === 'ENODATA') {
      return { found: false, timeout: false }
    }
    // Timeout or other error — don't block import
    return { found: true, timeout: true }
  }
}

// Full validation of a single email
export async function validateEmail(email: string): Promise<ValidationResult> {
  const lowerEmail = email.toLowerCase().trim()
  const domain = lowerEmail.split('@')[1]

  // 1. Syntax check
  if (!isValidSyntax(lowerEmail)) {
    return { email: lowerEmail, valid: false, reason: 'Invalid email format', category: 'invalid_syntax' }
  }

  // 2. Disposable domain check
  if (isDisposable(domain)) {
    return { email: lowerEmail, valid: false, reason: 'Disposable/temporary email domain', category: 'disposable' }
  }

  // 3. Role-based check (flag but don't reject — user decides)
  const roleBased = isRoleBased(lowerEmail)

  // 4. MX record check
  const mx = await hasMxRecords(domain)
  if (!mx.found && !mx.timeout) {
    return { email: lowerEmail, valid: false, reason: 'Domain has no mail server (no MX records)', category: 'no_mx' }
  }

  if (roleBased) {
    return { email: lowerEmail, valid: true, reason: 'Role-based email (info@, support@, etc.)', category: 'role_based', mxFound: mx.found }
  }

  return { email: lowerEmail, valid: true, reason: 'Valid', category: 'valid', mxFound: mx.found }
}

// Batch validate with concurrency limit
export async function validateEmailBatch(emails: string[], concurrency = 5): Promise<ValidationResult[]> {
  const results: ValidationResult[] = []
  
  for (let i = 0; i < emails.length; i += concurrency) {
    const batch = emails.slice(i, i + concurrency)
    const batchResults = await Promise.all(batch.map(email => validateEmail(email).catch(() => ({
      email,
      valid: true, // Don't block on validation errors
      reason: 'Validation timeout',
      category: 'timeout' as const,
    }))))
    results.push(...batchResults)
  }
  
  return results
}

// DeepSeek LLM integration for reply sentiment tagging.
// DeepSeek API is OpenAI-compatible: https://api.deepseek.com/v1/chat/completions
//
// To enable: set DEEPSEEK_API_KEY environment variable.
// When disabled (no key), sentiment tagging is skipped — replies get null sentiment.

const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions'
const DEEPSEEK_MODEL = 'deepseek-chat'

export type ReplySentiment = 'interested' | 'not_interested' | 'ooo' | 'unsubscribe' | 'neutral'

export function isLlmEnabled(): boolean {
  return !!process.env.DEEPSEEK_API_KEY
}

/**
 * Tag a reply's sentiment using DeepSeek.
 * Returns null if LLM is disabled or the call fails.
 */
export async function tagReplySentiment(
  fromEmail: string,
  subject: string,
  body: string
): Promise<ReplySentiment | null> {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) return null

  try {
    const truncatedBody = body.slice(0, 2000)
    const response = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You are an email classifier. Classify the reply into exactly one category: ' +
              '"interested" (wants to talk/learn more), ' +
              '"not_interested" (declines), ' +
              '"ooo" (out of office / auto-reply), ' +
              '"unsubscribe" (asks to be removed), ' +
              '"neutral" (unclear or other). ' +
              'Respond with ONLY the category name, nothing else.',
          },
          {
            role: 'user',
            content: `From: ${fromEmail}\nSubject: ${subject}\nBody: ${truncatedBody}`,
          },
        ],
        temperature: 0,
        max_tokens: 20,
      }),
    })

    if (!response.ok) {
      console.error('[llm] DeepSeek API error:', response.status, await response.text())
      return null
    }

    const data: any = await response.json()
    const content = data?.choices?.[0]?.message?.content?.trim().toLowerCase() || ''
    
    // Validate against allowed values
    const valid: ReplySentiment[] = ['interested', 'not_interested', 'ooo', 'unsubscribe', 'neutral']
    for (const v of valid) {
      if (content.includes(v)) return v
    }
    return 'neutral'
  } catch (e: any) {
    console.error('[llm] Sentiment tagging failed:', e?.message)
    return null
  }
}

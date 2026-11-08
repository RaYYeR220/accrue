import { t } from '../i18n'

function SignOnce() {
  return (
    <svg className="ill" viewBox="0 0 340 172" role="img" aria-label={t('landing.how.s1.aria')}>
      <path d="M46 63C46 32 120 18 161 18" className="h dsh" />
      <text x="72" y="34" className="tx">
        {t('landing.how.s1.permit')}
      </text>
      <circle cx="170" cy="18" r="8" className="h" />
      <text x="185" y="22" className="tx">
        {t('landing.how.s1.relayer')}
      </text>
      <path d="M170 26V63" className="h dsh" />
      <circle cx="46" cy="78" r="14" className="h" />
      <rect x="156" y="64" width="28" height="28" rx="2" className="h" />
      <circle cx="294" cy="78" r="14" className="h" />
      <path d="M61 78H153M148 74l5 4-5 4M187 78H277M272 74l5 4-5 4" className="h" />
      <text x="107" y="71" className="tx" textAnchor="middle">
        USDT0
      </text>
      <text x="232" y="71" className="tx" textAnchor="middle">
        {t('landing.how.s1.supply')}
      </text>
      <text x="46" y="110" className="tx" textAnchor="middle">
        {t('landing.how.s1.you')}
      </text>
      <text x="170" y="110" className="tx" textAnchor="middle">
        {t('landing.how.s1.router')}
      </text>
      <text x="294" y="110" className="tx" textAnchor="middle">
        Aave v3
      </text>
      <path d="M306 86C336 168 4 168 34 86" className="a" />
      <path d="M30 93l4-7 4 7" className="a" />
      <text x="170" y="164" className="tx ta" textAnchor="middle">
        {t('landing.how.s1.back')}
      </text>
    </svg>
  )
}

function Rings() {
  return (
    <svg className="ill" viewBox="0 0 340 172" role="img" aria-label={t('landing.how.s2.aria')}>
      <circle cx="136" cy="86" r="28" className="wash" />
      <circle cx="136" cy="86" r="35" className="a o1" />
      <circle cx="136" cy="86" r="41" className="a o2" />
      <circle cx="136" cy="86" r="47" className="a o3" />
      <circle cx="136" cy="86" r="53" className="a" />
      <circle cx="136" cy="86" r="59" className="a dsh" />
      <path d="M175 47L212 32H222" className="h" />
      <circle cx="175" cy="47" r="2" className="dot" />
      <text x="226" y="30" className="tx">
        {t('landing.how.s2.ring')}
      </text>
      <text x="226" y="46" className="tx tm">
        {t('landing.how.s2.dashed')}
      </text>
      <text x="136" y="90" className="tx" textAnchor="middle">
        NIM
      </text>
    </svg>
  )
}

function Matched() {
  return (
    <svg className="ill" viewBox="0 0 340 172" role="img" aria-label={t('landing.how.s3.aria')}>
      <text x="18" y="62" className="tx">
        {t('landing.how.s3.expected')}
      </text>
      <text x="18" y="110" className="tx">
        {t('landing.how.s3.received')}
      </text>
      <g className="h dsh">
        <path d="M104 46V72M136 46V72M168 46V72M200 46V72M232 46V72M264 46V72M296 46V72" />
      </g>
      <g className="h hf">
        <path d="M104 74V92M136 74V92M168 74V92M200 74V92M232 74V92M264 74V92" />
      </g>
      <g className="a">
        <path d="M104 94V120M136 94V120M168 94V120M200 94V120M232 94V120M264 94V120" />
      </g>
      <circle cx="296" cy="107" r="4" className="h dsh" />
      <text x="18" y="156" className="tx tm">
        {t('landing.how.s3.note')}
      </text>
    </svg>
  )
}

export function HowItWorks({ poolCount }: { poolCount: number }) {
  const steps = [
    { n: '01', ill: <SignOnce />, title: t('landing.how.s1.title'), body: t('landing.how.s1.body') },
    { n: '02', ill: <Rings />, title: t('landing.how.s2.title'), body: t('landing.how.s2.body', { n: poolCount }) },
    { n: '03', ill: <Matched />, title: t('landing.how.s3.title'), body: t('landing.how.s3.body') },
  ]
  return (
    <section className="section" id="how" aria-labelledby="how-title">
      <div className="wrap">
        <div className="sec-head">
          <div>
            <p className="eyebrow">{t('landing.how.eyebrow')}</p>
            <h2 className="h2" id="how-title">
              {t('landing.how.title')}
            </h2>
          </div>
          <p className="lede">{t('landing.how.lede')}</p>
        </div>
        <ol className="steps">
          {steps.map(s => (
            <li className="step" key={s.n}>
              {s.ill}
              <span className="n" aria-hidden="true">
                {s.n}
              </span>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}

import { useState, useEffect } from 'react'
import type { UmatResultsResponse } from './types'

function App() {
  // App state
  const [indexNumber, setIndexNumber] = useState<string>(() => localStorage.getItem('pluxy_user') || '')
  const [pin, setPin] = useState<string>('')
  const [results, setResults] = useState<UmatResultsResponse | null>(null)
  const [syncsRemaining, setSyncsRemaining] = useState<number>(5)
  
  const [loading, setLoading] = useState<boolean>(false)
  const [polling, setPolling] = useState<boolean>(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  
  const [activeTab, setActiveTab] = useState<'overview' | 'courses' | 'insights'>('overview')
  const [selectedSemesterId, setSelectedSemesterId] = useState<number | null>(null)
  const [hoveredPoint, setHoveredPoint] = useState<{ index: number; x: number; y: number; cwa: number; average: number } | null>(null)

  // Fetch remaining manual sync allowance
  const fetchUserStatus = async (user: string) => {
    try {
      const res = await fetch(`/api/user-status/${user}`)
      if (res.ok) {
        const json = await res.json()
        if (json.registered) {
          setSyncsRemaining(json.syncsRemaining ?? 5)
        }
      }
    } catch (err) {
      console.error('Failed to fetch user status:', err)
    }
  }

  // Auto-fetch results on mount if index number is saved
  useEffect(() => {
    const savedUser = localStorage.getItem('pluxy_user')
    if (savedUser) {
      fetchCachedResults(savedUser)
      fetchUserStatus(savedUser)
    }
  }, [])

  // Auto-select latest semester when data loads
  useEffect(() => {
    if (results && results.data && results.data.length > 0) {
      const latest = results.data[results.data.length - 1].studentResultId
      setSelectedSemesterId(latest)
    }
  }, [results])

  const fetchCachedResults = async (user: string) => {
    setLoading(true)
    setErrorMsg(null)
    setSuccessMsg(null)
    
    try {
      const res = await fetch(`/api/my-results/${user}`)
      const json = await res.json()
      
      if (res.status === 202) {
        setPolling(true)
        setSuccessMsg('Syncing results from UMaT portal. Please wait...')
        setTimeout(() => fetchCachedResults(user), 3000)
      } else if (res.ok && json.data) {
        setResults(json)
        setPolling(false)
        setSuccessMsg(null)
        localStorage.setItem('pluxy_user', user)
      } else {
        setErrorMsg(json.error || 'Failed to fetch results. Check index number.')
        setPolling(false)
      }
    } catch (err) {
      setErrorMsg('Could not connect to the API server. Make sure wrangler dev is running.')
      setPolling(false)
    } finally {
      setLoading(false)
    }
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!indexNumber || !pin) {
      setErrorMsg('Please fill in both Index Number and PIN.')
      return
    }

    setLoading(true)
    setErrorMsg(null)
    setSuccessMsg('Registering credentials and starting sync...')

    try {
      const registerRes = await fetch('/api/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: indexNumber, password: pin })
      })
      const regJson = await registerRes.json()

      if (!registerRes.ok) {
        throw new Error(regJson.error || 'Sign connection failed')
      }

      localStorage.setItem('pluxy_user', indexNumber)
      fetchCachedResults(indexNumber)
      fetchUserStatus(indexNumber)
    } catch (err: any) {
      setErrorMsg(err.message || 'Connection error. Please try again.')
      setLoading(false)
    }
  }

  const handleRefresh = async () => {
    if (!indexNumber) return

    setLoading(true)
    setErrorMsg(null)
    setSuccessMsg('Syncing cache with UMaT portal...')

    try {
      const res = await fetch(`/api/refresh/${indexNumber}`, { method: 'POST' })
      const json = await res.json()

      if (res.ok && json.data) {
        setResults(json.data)
        setSuccessMsg('Dashboard updated successfully.')
        setSyncsRemaining((prev) => Math.max(0, prev - 1))
        setTimeout(() => setSuccessMsg(null), 3000)
      } else {
        setErrorMsg(json.error || 'Portal refresh failed.')
        if (res.status === 429) {
          setSyncsRemaining(0)
        }
      }
    } catch (err) {
      setErrorMsg('Network error while refreshing.')
    } finally {
      setLoading(false)
    }
  }

  const handleDisconnect = () => {
    localStorage.removeItem('pluxy_user')
    setResults(null)
    setIndexNumber('')
    setPin('')
    setErrorMsg(null)
    setSuccessMsg(null)
  }

  // Dashboard Stats Calculations
  const semestersList = results?.data || []
  const semestersCount = semestersList.length
  
  const semestersCountIsOdd = semestersCount % 2 !== 0
  const isWaitingForResults = !semestersCountIsOdd
  
  const currentYear = semestersCount === 0 ? 1 : Math.ceil((semestersCount + 1) / 2)
  const waitingSemesterName = `Year ${currentYear} Semester 1`

  const latestSemester = semestersList.find(s => s.studentResultId === selectedSemesterId) || semestersList[semestersList.length - 1]

  const overallCwa = semestersList.length > 0 ? semestersList[semestersList.length - 1].cwa : 0
  const totalEarnedCredits = semestersList.length > 0 ? semestersList[semestersList.length - 1].cumulativeCreditEarned : 0
  const totalRegisteredCredits = semestersList.length > 0 ? semestersList[semestersList.length - 1].cumulativeCreditRegistered : 0

  const allSheets = semestersList.flatMap(s => s.sheets || [])
  const gradeCounts = allSheets.reduce((acc, sheet) => {
    const l = sheet.letter.charAt(0)
    acc[l] = (acc[l] || 0) + 1
    return acc
  }, {} as Record<string, number>)

  const topCourses = [...allSheets]
    .sort((a, b) => b.fullScore - a.fullScore)
    .slice(0, 5)

  // SVG Chart Calculations
  const chartWidth = 700
  const chartHeight = 300
  const chartPadding = 45

  const getCoordinates = () => {
    if (semestersList.length === 0) return { cwaPoints: [], avgPoints: [], minVal: 0, maxVal: 100 }
    
    const allValues = semestersList.flatMap(s => [s.cwa, s.semesterAverage])
    const minVal = Math.max(40, Math.min(...allValues) - 3)
    const maxVal = Math.min(100, Math.max(...allValues) + 3)
    
    const cwaPoints: { x: number; y: number; cwa: number; average: number; semester: string; index: number }[] = []
    const avgPoints: { x: number; y: number; cwa: number; average: number; semester: string; index: number }[] = []

    semestersList.forEach((sem, idx) => {
      const x = chartPadding + (idx * (chartWidth - 2 * chartPadding)) / Math.max(1, semestersList.length - 1)
      const yCwa = (chartHeight - chartPadding) - ((sem.cwa - minVal) * (chartHeight - 2 * chartPadding)) / (maxVal - minVal)
      const yAvg = (chartHeight - chartPadding) - ((sem.semesterAverage - minVal) * (chartHeight - 2 * chartPadding)) / (maxVal - minVal)
      
      const semLabel = `Y${Math.floor(sem.year / 100)}S${sem.semester}`
      
      cwaPoints.push({ x, y: yCwa, cwa: sem.cwa, average: sem.semesterAverage, semester: semLabel, index: idx })
      avgPoints.push({ x, y: yAvg, cwa: sem.cwa, average: sem.semesterAverage, semester: semLabel, index: idx })
    })

    return { cwaPoints, avgPoints, minVal, maxVal }
  }

  const { cwaPoints, avgPoints, minVal, maxVal } = getCoordinates()

  // 1. Sleek, Modern Login Screen (Aligned with Website Layout)
  if (!results) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '80vh', maxWidth: '460px', margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: '40px' }}>
          <h1 style={{ fontSize: '2.5rem', fontWeight: '700', letterSpacing: '-0.03em', margin: '0 0 10px 0' }}>Pluxy</h1>
          <p style={{ color: 'var(--text-secondary)', margin: 0, fontSize: '1rem' }}>
            Secure portal synchronizer for UMaT grades.
          </p>
        </div>

        {errorMsg && (
          <div className="status-banner status-banner-error" style={{ width: '100%' }}>
            {errorMsg}
          </div>
        )}

        {successMsg && (
          <div className="status-banner status-banner-success" style={{ width: '100%' }}>
            {successMsg}
          </div>
        )}

        {polling ? (
          <div className="dashboard-panel" style={{ width: '100%', textAlign: 'center', boxSizing: 'border-box' }}>
            <div style={{ display: 'inline-block', width: '24px', height: '24px', border: '3px solid var(--text-secondary)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite', marginBottom: '20px' }}></div>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            <h3 style={{ margin: '0 0 10px 0', fontSize: '1.2rem' }}>Syncing Portal Logs</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', margin: 0, lineHeight: '1.5' }}>
              Downloading records from the UMaT secure gateway...
            </p>
          </div>
        ) : (
          <div className="dashboard-panel" style={{ width: '100%', boxSizing: 'border-box' }}>
            <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <div className="input-group">
                <label>Student Index Number</label>
                <input 
                  type="text" 
                  placeholder="90123..." 
                  value={indexNumber}
                  onChange={(e) => setIndexNumber(e.target.value)}
                  disabled={loading}
                  required
                />
              </div>
              <div className="input-group">
                <label>UMaT Portal PIN</label>
                <input 
                  type="password" 
                  placeholder="••••••••" 
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  disabled={loading}
                  required
                />
              </div>
              <button type="submit" className="btn-solid" disabled={loading} style={{ width: '100%', padding: '14px', borderRadius: '8px' }}>
                {loading ? 'Initializing sync...' : 'Link Account'}
              </button>
            </form>
          </div>
        )}
      </div>
    )
  }

  // 2. Premium Clean Dashboard View
  return (
    <div>
      {/* Top Header matching Portfolio Navigation */}
      <div className="app-header">
        <h2 className="app-title">{results.studentName}</h2>
        <div className="header-links">
          <span>Index: {indexNumber}</span>
          <button 
            onClick={handleRefresh} 
            disabled={loading || syncsRemaining === 0} 
            style={{ fontWeight: '500' }}
          >
            {loading ? 'Syncing...' : `Sync Portal (${syncsRemaining} left)`}
          </button>
          <button onClick={handleDisconnect} style={{ fontWeight: '500', color: 'var(--accent-rust)' }}>
            Disconnect
          </button>
        </div>
      </div>

      {/* Release check status alert banners */}
      {semestersCount > 0 && (
        isWaitingForResults ? (
          <div className="status-banner status-banner-warning">
            <strong>Awaiting Semester Release</strong>: Pluxy is checking the portal for your <strong>{waitingSemesterName}</strong> grades. Our background script runs checks every 30m.
          </div>
        ) : (
          <div className="status-banner status-banner-success">
            <strong>✓ Results Released</strong>: Your current <strong>Year {currentYear} Semester 1</strong> grades have been successfully fetched and cached.
          </div>
        )
      )}

      {errorMsg && (
        <div className="status-banner status-banner-error">
          {errorMsg}
        </div>
      )}

      {successMsg && (
        <div className="status-banner status-banner-success">
          {successMsg}
        </div>
      )}

      {/* KPI Grid Panel mirroring Portfolio section details */}
      <div className="kpi-grid">
        <div className="kpi-cell">
          <span className="kpi-label">Cumulative CWA</span>
          <span className="kpi-value" style={{ color: 'var(--accent-rust)' }}>
            {overallCwa.toFixed(2)}
          </span>
        </div>
        <div className="kpi-cell">
          <span className="kpi-label">Credits Earned</span>
          <span className="kpi-value">
            {totalEarnedCredits} <span style={{ fontSize: '1.2rem', color: 'var(--text-secondary)' }}>/ {totalRegisteredCredits}</span>
          </span>
        </div>
        <div className="kpi-cell">
          <span className="kpi-label">Semester Average</span>
          <span className="kpi-value">
            {latestSemester ? latestSemester.semesterAverage.toFixed(2) : '0.00'}
          </span>
        </div>
        <div className="kpi-cell">
          <span className="kpi-label">Last Checked</span>
          <span className="kpi-value" style={{ fontSize: '1.5rem', alignSelf: 'flex-start', margin: '6px 0' }}>
            {results.updated ? new Date(results.updated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'JUST NOW'}
          </span>
        </div>
      </div>

      {/* If 0 results are returned (e.g. Year 1 student before first sem results release) */}
      {semestersCount === 0 ? (
        <div className="dashboard-panel" style={{ padding: '60px 40px', textAlign: 'center' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '20px' }}>📦</div>
          <h2 style={{ fontSize: '1.8rem', fontWeight: '600', margin: '0 0 12px 0' }}>Connection Active</h2>
          <p style={{ color: 'var(--text-secondary)', maxWidth: '600px', margin: '0 auto 30px auto', lineHeight: '1.6' }}>
            Your account is verified. Since you are a first-year student and your first-semester results ({waitingSemesterName}) are not yet posted, there are no historical stats to plot. Pluxy will build your dashboard immediately upon publication.
          </p>
          <button onClick={handleRefresh} className="btn-outline" disabled={loading}>
            {loading ? 'Refreshing cache...' : 'Check Portal Now'}
          </button>
        </div>
      ) : (
        /* Regular Dashboard Layout for students with grades */
        <>
          {/* Sub Navigation tabs */}
          <div className="nav-tabs">
            <button 
              className={`tab-link ${activeTab === 'overview' ? 'active' : ''}`}
              onClick={() => setActiveTab('overview')}
            >
              Overview
            </button>
            <button 
              className={`tab-link ${activeTab === 'courses' ? 'active' : ''}`}
              onClick={() => setActiveTab('courses')}
            >
              Semester Receipts
            </button>
            <button 
              className={`tab-link ${activeTab === 'insights' ? 'active' : ''}`}
              onClick={() => setActiveTab('insights')}
            >
              Analytics
            </button>
          </div>

          {/* Tab 1: Overview Chart */}
          {activeTab === 'overview' && (
            <div className="dashboard-panel">
              <div className="chart-header">
                <div>
                  <h3 style={{ margin: '0 0 4px 0', fontSize: '1.2rem', fontWeight: '600' }}>Academic Trend</h3>
                  <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Graphing cumulative CWA and semester indices</p>
                </div>
                <div className="chart-legend">
                  <span style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-primary)' }}>
                    <span style={{ display: 'inline-block', width: '12px', height: '3px', background: 'var(--text-primary)' }}></span>
                    CWA
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--accent-rust)' }}>
                    <span style={{ display: 'inline-block', width: '12px', height: '2px', borderTop: '2px dashed var(--accent-rust)' }}></span>
                    Semester Avg
                  </span>
                </div>
              </div>

              <div className="graph-scroll-wrapper" style={{ background: '#FFFFFF', border: '1px solid var(--border-clean)', borderRadius: '8px', padding: '20px' }}>
                <svg className="graph-svg" width="100%" height={chartHeight} viewBox={`0 0 ${chartWidth} ${chartHeight}`} preserveAspectRatio="xMidYMid meet">
                  {/* Grid Lines */}
                  {[40, 50, 60, 70, 80, 90, 100].map((gridVal) => {
                    if (gridVal < minVal || gridVal > maxVal) return null
                    const y = (chartHeight - chartPadding) - ((gridVal - minVal) * (chartHeight - 2 * chartPadding)) / (maxVal - minVal)
                    return (
                      <g key={gridVal}>
                        <line x1={chartPadding} y1={y} x2={chartWidth - chartPadding} y2={y} stroke="var(--border-clean)" strokeWidth="0.5" />
                        <text x={chartPadding - 12} y={y + 4} fontFamily="var(--font-mono)" fontSize="9" textAnchor="end" fill="var(--text-secondary)">
                          {gridVal}
                        </text>
                      </g>
                    )
                  })}

                  {/* X Axis labels */}
                  {cwaPoints.map((pt, idx) => (
                    <g key={idx}>
                      <line x1={pt.x} y1={chartPadding} x2={pt.x} y2={chartHeight - chartPadding} stroke="var(--border-clean)" strokeWidth="0.5" strokeDasharray="3 3" />
                      <text x={pt.x} y={chartHeight - chartPadding + 20} fontFamily="var(--font-sans)" fontSize="10" textAnchor="middle" fill="var(--text-primary)" fontWeight="500">
                        {pt.semester}
                      </text>
                    </g>
                  ))}

                  {/* CWA Line */}
                  <path d={cwaPoints.map((pt, idx) => `${idx === 0 ? 'M' : 'L'} ${pt.x} ${pt.y}`).join(' ')} fill="none" stroke="var(--text-primary)" strokeWidth="2.5" strokeLinecap="round" />

                  {/* Semester Avg Line */}
                  <path d={avgPoints.map((pt, idx) => `${idx === 0 ? 'M' : 'L'} ${pt.x} ${pt.y}`).join(' ')} fill="none" stroke="var(--accent-rust)" strokeWidth="1.5" strokeDasharray="4 4" strokeLinecap="round" />

                  {/* Plot Dots */}
                  {cwaPoints.map((pt, idx) => (
                    <g key={idx}>
                      <circle cx={pt.x} cy={pt.y} r="4" fill="var(--panel-bg)" stroke="var(--text-primary)" strokeWidth="2" />
                      <circle cx={pt.x} cy={avgPoints[idx].y} r="3" fill="var(--accent-rust)" stroke="var(--accent-rust)" />
                      <rect
                        x={pt.x - 20}
                        y={0}
                        width={40}
                        height={chartHeight}
                        fill="transparent"
                        style={{ cursor: 'pointer' }}
                        onMouseEnter={() => {
                          setHoveredPoint({
                            index: idx,
                            x: pt.x,
                            y: (pt.y + avgPoints[idx].y) / 2,
                            cwa: pt.cwa,
                            average: pt.average
                          })
                        }}
                        onMouseLeave={() => setHoveredPoint(null)}
                        onClick={() => {
                          const sem = semestersList[idx]
                          setSelectedSemesterId(sem.studentResultId)
                          setActiveTab('courses')
                        }}
                      />
                    </g>
                  ))}

                  {/* Tooltip */}
                  {hoveredPoint && (
                    <g transform={`translate(${hoveredPoint.x + 15 > chartWidth - 140 ? hoveredPoint.x - 145 : hoveredPoint.x + 10}, ${hoveredPoint.y - 45})`}>
                      <rect width="135" height="60" fill="var(--text-primary)" rx="4" />
                      <text x="12" y="20" fontFamily="var(--font-mono)" fontSize="10" fontWeight="bold" fill="var(--bg-clean)">
                        CWA: {hoveredPoint.cwa.toFixed(2)}
                      </text>
                      <text x="12" y="36" fontFamily="var(--font-mono)" fontSize="10" fill="rgba(250,249,246,0.7)">
                        SEM AVG: {hoveredPoint.average.toFixed(2)}
                      </text>
                      <text x="12" y="48" fontFamily="var(--font-sans)" fontSize="8" fill="rgba(250,249,246,0.5)" style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        Click to view sheet
                      </text>
                    </g>
                  )}
                </svg>
              </div>
            </div>
          )}

          {/* Tab 2: Detailed Course Sheets (Receipt Style) */}
          {activeTab === 'courses' && (
            <div className="receipts-layout">
              {/* Semesters Sidebar */}
              <div className="receipts-sidebar">
                <span className="section-label">Select Semester</span>
                {semestersList.map((sem) => {
                  const isActive = sem.studentResultId === selectedSemesterId
                  return (
                    <div 
                      key={sem.studentResultId}
                      className={`dashboard-panel sidebar-card ${isActive ? 'active' : ''}`}
                      onClick={() => setSelectedSemesterId(sem.studentResultId)}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                        <div>
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{sem.academicYear}</span>
                          <h4 style={{ margin: '4px 0 0 0', fontWeight: '600', fontSize: '0.95rem' }}>
                            Y{Math.floor(sem.year / 100)} Sem {sem.semester}
                          </h4>
                        </div>
                        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 'bold', fontSize: '0.95rem', color: isActive ? 'var(--accent-rust)' : 'var(--text-primary)' }}>
                          {sem.cwa.toFixed(2)}
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* Selected Semester Detail Receipt */}
              <div className="dashboard-panel" style={{ margin: 0 }}>
                {latestSemester ? (
                  <>
                    <div className="receipt-header">
                      <div>
                        <span className="section-label">Official Record</span>
                        <h2 style={{ border: 'none', padding: 0, margin: '4px 0 0 0', fontSize: '1.8rem', fontWeight: '600' }}>
                          Year {Math.floor(latestSemester.year / 100)} Semester {latestSemester.semester}
                        </h2>
                        <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'block', marginTop: '4px' }}>
                          Academic Session: {latestSemester.academicYear}
                        </span>
                      </div>
                      <div className="receipt-cwa-block">
                        <span className="section-label">Semester CWA</span>
                        <div style={{ fontSize: '2rem', fontWeight: '600', color: 'var(--accent-rust)', letterSpacing: '-0.02em', lineHeight: 1, marginTop: '4px' }}>
                          {latestSemester.cwa.toFixed(2)}
                        </div>
                      </div>
                    </div>

                    <div className="table-wrapper">
                      <table className="sleek-table">
                        <thead>
                          <tr>
                            <th>Code</th>
                            <th>Course Title</th>
                            <th style={{ textAlign: 'center' }}>Credits</th>
                            {latestSemester.sheets.some(s => s.classScore > 0) && (
                              <>
                                <th style={{ textAlign: 'center' }}>Class</th>
                                <th style={{ textAlign: 'center' }}>Exam</th>
                              </>
                            )}
                            <th style={{ textAlign: 'center' }}>Score</th>
                            <th style={{ textAlign: 'center' }}>Grade</th>
                          </tr>
                        </thead>
                        <tbody>
                          {latestSemester.sheets.map((sheet) => {
                            const hasScores = sheet.classScore > 0 || sheet.examScore > 0
                            return (
                              <tr key={sheet.studentResultSheetId}>
                                <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{sheet.code}</td>
                                <td style={{ fontWeight: '500' }}>{sheet.courseName}</td>
                                <td style={{ textAlign: 'center', fontFamily: 'var(--font-mono)' }}>{sheet.credit}</td>
                                {latestSemester.sheets.some(s => s.classScore > 0) && (
                                  <>
                                    <td style={{ textAlign: 'center', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
                                      {hasScores ? sheet.classScore : '-'}
                                    </td>
                                    <td style={{ textAlign: 'center', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
                                      {hasScores ? sheet.examScore : '-'}
                                    </td>
                                  </>
                                )}
                                <td style={{ textAlign: 'center', fontFamily: 'var(--font-mono)', fontWeight: 'bold' }}>
                                  {sheet.fullScore.toFixed(1)}
                                </td>
                                <td style={{ textAlign: 'center' }}>
                                  <span className={`grade-tag ${sheet.letter.charAt(0)}`}>
                                    {sheet.letter}
                                  </span>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>

                    <div className="receipt-summary">
                      <div style={{ color: 'var(--text-secondary)' }}>
                        CREDITS: REGISTERED <strong>{latestSemester.creditRegistered}</strong> | EARNED <strong>{latestSemester.creditEarned}</strong>
                      </div>
                      <div style={{ color: 'var(--text-secondary)' }}>
                        SEMESTER AVG WEIGHTED MARK: <strong>{latestSemester.semesterAverage.toFixed(2)}%</strong>
                      </div>
                    </div>
                  </>
                ) : (
                  <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>
                    Select a semester to render grades.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Tab 3: Insights & Analytics */}
          {activeTab === 'insights' && (
            <div className="layout-split">
              <div className="dashboard-panel">
                <h3 style={{ margin: '0 0 6px 0', fontSize: '1.2rem', fontWeight: '600' }}>Grade Frequency</h3>
                <p style={{ margin: '0 0 24px 0', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Distribution of letter grades across all semesters</p>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                  {['A', 'B', 'C', 'D'].map(grade => {
                    const count = gradeCounts[grade] || 0
                    const total = allSheets.length
                    const percentage = total > 0 ? (count / total) * 100 : 0
                    return (
                      <div key={grade} style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 'bold', width: '20px' }}>{grade}</span>
                        <div style={{ flexGrow: 1, height: '12px', background: 'var(--border-clean)', borderRadius: '6px', overflow: 'hidden' }}>
                          <div 
                            style={{ 
                              height: '100%', 
                              width: `${percentage}%`, 
                              background: grade === 'A' ? 'var(--accent-teal)' : grade === 'B' ? 'var(--accent-teal)' : grade === 'C' ? 'var(--text-secondary)' : 'var(--accent-rust)',
                              opacity: grade === 'B' ? 0.7 : 1
                            }}
                          ></div>
                        </div>
                        <span style={{ width: '50px', textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                          {count} ({Math.round(percentage)}%)
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>

              <div className="dashboard-panel">
                <h3 style={{ margin: '0 0 6px 0', fontSize: '1.2rem', fontWeight: '600' }}>Academic Strengths</h3>
                <p style={{ margin: '0 0 24px 0', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Top 5 courses scored across the entire curriculum</p>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
                  {topCourses.map((course, idx) => (
                    <div 
                      key={course.studentResultSheetId}
                      style={{ 
                        display: 'flex', 
                        justifyContent: 'space-between', 
                        alignItems: 'center',
                        borderBottom: '1px solid var(--border-clean)',
                        paddingBottom: '10px'
                      }}
                    >
                      <div style={{ flex: '1', minWidth: 0, paddingRight: '15px' }}>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>#{idx + 1} | {course.code}</span>
                        <h4 style={{ margin: '2px 0 0 0', fontWeight: '500', fontSize: '0.95rem', wordBreak: 'break-word' }}>{course.courseName}</h4>
                      </div>
                      <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}>
                        <span className={`grade-tag ${course.letter.charAt(0)}`}>{course.letter}</span>
                        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{course.fullScore}%</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}


        </>
      )}
    </div>
  )
}

export default App

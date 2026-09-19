import { expect, test } from '@playwright/test'

import { launchLocalWebHost } from './helpers/local-web'

test('authenticated browser applies and saves one approved formula-and-chart operation across reload', async ({
  page,
}) => {
  const host = await launchLocalWebHost()
  const approvals: string[] = []
  page.on('dialog', async (dialog) => {
    approvals.push(dialog.message())
    await dialog.accept()
  })

  try {
    await page.goto(host.bootstrapUrl)
    await expect(page.getByText('Local Host connected')).toBeVisible()
    await page.getByRole('link', { name: 'Forecast.xlsx' }).first().click()

    const editor = page.frameLocator('iframe[title="Forecast.xlsx"]')
    await editor
      .getByRole('textbox', { name: 'AI instruction' })
      .fill('Add a total formula and a revenue chart.')
    await editor.getByRole('textbox', { name: 'AI instruction' }).press('Enter')
    await expect(editor.getByText('Preparing the formula and chart.')).toBeVisible()
    await expect(editor.getByText('Workbook saved.')).toBeVisible()
    expect(approvals).toHaveLength(1)

    await page.reload()
    await expect(page.getByText('Local Host connected')).toBeVisible()
    const reloadedEditor = page.frameLocator('iframe[title="Forecast.xlsx"]')
    await reloadedEditor
      .getByRole('textbox', { name: 'AI instruction' })
      .fill('Retry the same accepted operation.')
    await reloadedEditor.getByRole('textbox', { name: 'AI instruction' }).press('Enter')
    await expect(reloadedEditor.getByText('Workbook saved.')).toBeVisible()

    const workbook = await host.readFinalWorkbook()
    expect(workbook.rows).toEqual([
      ['Quarter', 'Revenue'],
      ['Q1', 12],
      ['Q2', 18],
      ['Total', 30],
    ])
    expect(workbook.formulas).toEqual({ B4: '=SUM(B2:B3)' })
    expect(workbook.charts).toEqual([
      expect.objectContaining({ title: 'Revenue by quarter', types: ['barChart'] }),
    ])
  } finally {
    await host.close()
  }
})

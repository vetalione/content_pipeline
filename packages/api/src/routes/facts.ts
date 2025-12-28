import { Router } from 'express';
import { prisma } from '../lib/db';

const router = Router();

/**
 * GET /api/articles/:articleId/facts/:factId
 * Get a specific fact with its sources
 */
router.get('/articles/:articleId/facts/:factId', async (req, res) => {
  try {
    const { articleId, factId } = req.params;

    const article = await prisma.article.findUnique({
      where: { id: articleId },
    });

    if (!article) {
      return res.status(404).json({ error: 'Article not found' });
    }

    const researchData = article.researchData as any;
    const fact = researchData?.facts?.find((f: any) => f.id === factId);

    if (!fact) {
      return res.status(404).json({ error: 'Fact not found' });
    }

    res.json({ success: true, data: fact });
  } catch (error) {
    console.error('Error fetching fact:', error);
    res.status(500).json({ error: 'Failed to fetch fact' });
  }
});

/**
 * PATCH /api/articles/:articleId/facts/:factId
 * Update a specific fact (edit by user)
 */
router.patch('/articles/:articleId/facts/:factId', async (req, res) => {
  try {
    const { articleId, factId } = req.params;
    const updates = req.body;

    const article = await prisma.article.findUnique({
      where: { id: articleId },
    });

    if (!article) {
      return res.status(404).json({ error: 'Article not found' });
    }

    const researchData = article.researchData as any;
    const factIndex = researchData?.facts?.findIndex((f: any) => f.id === factId);

    if (factIndex === -1 || factIndex === undefined) {
      return res.status(404).json({ error: 'Fact not found' });
    }

    // Update the fact
    researchData.facts[factIndex] = {
      ...researchData.facts[factIndex],
      ...updates,
      isEdited: true,
      editedAt: new Date().toISOString(),
    };

    // Save back to database
    const updatedArticle = await prisma.article.update({
      where: { id: articleId },
      data: {
        researchData: researchData,
        updatedAt: new Date(),
      },
    });

    res.json({ 
      success: true, 
      data: researchData.facts[factIndex],
      message: 'Fact updated successfully' 
    });
  } catch (error) {
    console.error('Error updating fact:', error);
    res.status(500).json({ error: 'Failed to update fact' });
  }
});

/**
 * DELETE /api/articles/:articleId/facts/:factId
 * Soft delete a fact (mark as deleted, don't remove)
 */
router.delete('/articles/:articleId/facts/:factId', async (req, res) => {
  try {
    const { articleId, factId } = req.params;

    const article = await prisma.article.findUnique({
      where: { id: articleId },
    });

    if (!article) {
      return res.status(404).json({ error: 'Article not found' });
    }

    const researchData = article.researchData as any;
    const factIndex = researchData?.facts?.findIndex((f: any) => f.id === factId);

    if (factIndex === -1 || factIndex === undefined) {
      return res.status(404).json({ error: 'Fact not found' });
    }

    // Soft delete: mark as deleted
    researchData.facts[factIndex].isDeleted = true;

    // Save back to database
    await prisma.article.update({
      where: { id: articleId },
      data: {
        researchData: researchData,
        updatedAt: new Date(),
      },
    });

    res.json({ 
      success: true, 
      message: 'Fact deleted successfully' 
    });
  } catch (error) {
    console.error('Error deleting fact:', error);
    res.status(500).json({ error: 'Failed to delete fact' });
  }
});

/**
 * POST /api/articles/:articleId/facts/:factId/restore
 * Restore a soft-deleted fact
 */
router.post('/articles/:articleId/facts/:factId/restore', async (req, res) => {
  try {
    const { articleId, factId } = req.params;

    const article = await prisma.article.findUnique({
      where: { id: articleId },
    });

    if (!article) {
      return res.status(404).json({ error: 'Article not found' });
    }

    const researchData = article.researchData as any;
    const factIndex = researchData?.facts?.findIndex((f: any) => f.id === factId);

    if (factIndex === -1 || factIndex === undefined) {
      return res.status(404).json({ error: 'Fact not found' });
    }

    // Restore: unmark deleted
    researchData.facts[factIndex].isDeleted = false;

    // Save back to database
    await prisma.article.update({
      where: { id: articleId },
      data: {
        researchData: researchData,
        updatedAt: new Date(),
      },
    });

    res.json({ 
      success: true, 
      message: 'Fact restored successfully' 
    });
  } catch (error) {
    console.error('Error restoring fact:', error);
    res.status(500).json({ error: 'Failed to restore fact' });
  }
});

export default router;
